import express, { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const apiKey = process.env.GEMINI_API_KEY || '';

let ai: GoogleGenAI | null = null;
let cachedModel: string | null = null;
let cachedModelAt = 0;
const MODEL_TTL = 30 * 60 * 1000;

const FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-pro',
];

function ensureAi(): GoogleGenAI {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('کلید GEMINI_API_KEY در متغیرهای محیطی یافت نشد.');
    }
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
  }
  return ai;
}

async function resolveServerModel(aiInstance: GoogleGenAI): Promise<string[]> {
  if (cachedModel && Date.now() - cachedModelAt < MODEL_TTL) {
    return [cachedModel, ...FALLBACK_MODELS.filter((m) => m !== cachedModel)];
  }
  try {
    const list = await aiInstance.models.list();
    const names: string[] = [];
    for await (const m of list) {
      const name = (m.name || '').replace(/^models\//, '');
      const methods = (m as { supportedGenerationMethods?: string[] }).supportedGenerationMethods || [];
      if (name && (methods.includes('generateContent') || methods.length === 0)) {
        if (!/embedding|aqa|gecko/i.test(name)) names.push(name);
      }
    }
    const ranked = [
      ...names.filter((n) => /flash/i.test(n)),
      ...names.filter((n) => !/flash/i.test(n)),
    ];
    const unique = [...new Set([...ranked, ...FALLBACK_MODELS])];
    if (unique[0]) {
      cachedModel = unique[0];
      cachedModelAt = Date.now();
    }
    return unique.length ? unique : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

async function generateWithFallback(aiInstance: GoogleGenAI, params: Record<string, unknown>) {
  const models = await resolveServerModel(aiInstance);
  let lastErr: unknown;
  for (const model of models.slice(0, 3)) {
    try {
      const resp = await aiInstance.models.generateContent({
        ...params,
        model,
      });
      cachedModel = model;
      cachedModelAt = Date.now();
      return { response: resp, modelUsed: model };
    } catch (e) {
      lastErr = e;
      cachedModel = null;
    }
  }
  throw lastErr || new Error('هیچ مدل Gemini پاسخ نداد');
}

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
}

app.get('/api/gemini/status', async (_req: Request, res: Response) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.json({
      configured: false,
      connected: false,
      message: 'کلید GEMINI_API_KEY در متغیرهای محیطی یافت نشد.',
    });
  }
  try {
    const instance = ensureAi();
    const { response, modelUsed } = await generateWithFallback(instance, {
      contents: 'پینگ تست اتصال. یک کلمه پاسخ بده: متصل.',
    });
    return res.json({
      configured: true,
      connected: true,
      model: modelUsed,
      message: `اتصال هوش مصنوعی Gemini برقرار شد. مدل: ${modelUsed}`,
      reply: response.text?.trim() || 'متصل',
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'خطای نامشخص';
    return res.status(500).json({
      configured: true,
      connected: false,
      message: 'خطا در برقراری ارتباط با Gemini',
      error: errorMessage,
    });
  }
});

app.post('/api/gemini/analyze', async (req: Request, res: Response) => {
  try {
    const instance = ensureAi();
    const { type, context, prompt } = req.body;
    const systemInstruction = `تو یک مهندس ارشد اندروید، تحلیل‌گر کدهای باینری، متخصص مهندسی معکوس قانونی و کارشناس امنیت اپلیکیشن هستی.
همیشه پاسخ‌ها را به زبان فارسی، ساختاریافته، دقیق و کاربردی ارائه بده.`;
    const fullPrompt = `نوع درخواست: ${type || 'تحلیل عمومی'}\nاطلاعات:\n${typeof context === 'object' ? JSON.stringify(context, null, 2) : context}\n\nپرسش: ${prompt || 'تحلیل جامع ارائه کن.'}`;
    const { response, modelUsed } = await generateWithFallback(instance, {
      contents: fullPrompt,
      config: { systemInstruction, temperature: 0.4 },
    });
    return res.json({ text: response.text || 'پاسخی دریافت نشد.', model: modelUsed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'خطا در تحلیل';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  try {
    const instance = ensureAi();
    const { messages, apkContext } = req.body;
    const systemInstruction = `تو دستیار هوشمند APK AI Studio هستی. به زبان فارسی پاسخ بده.\nبافت APK: ${JSON.stringify(apkContext || {}).slice(0, 3000)}`;
    const contents: any[] = [];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'سلام' }] });
    }
    const { response, modelUsed } = await generateWithFallback(instance, {
      contents,
      config: { systemInstruction, temperature: 0.5 },
    });
    return res.json({ reply: response.text || 'پاسخی دریافت نشد.', model: modelUsed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'خطای چت';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/gemini/agent', async (req: Request, res: Response) => {
  try {
    const instance = ensureAi();
    const { goal, apkSummary, filesList, step } = req.body;
    const prompt = `هدف: "${goal}"\nمرحله: ${step || 'بررسی'}\nAPK: ${JSON.stringify(apkSummary || {})}\nفایل‌ها: ${(filesList || []).slice(0, 30).join(', ')}\n\nخروجی JSON معتبر با کلیدهای finding, affectedFile, proposedDiff (before/after), explanation, securityImpact, canBuildDirectly.`;
    const { response, modelUsed } = await generateWithFallback(instance, {
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(response.text || '{}');
    } catch {
      parsed = {
        finding: response.text,
        affectedFile: 'AndroidManifest.xml',
        proposedDiff: { before: '', after: '' },
        explanation: 'تحلیل انجام شد.',
      };
    }
    return res.json({ ...parsed, model: modelUsed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'خطای ایجنت';
    return res.status(500).json({ error: message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        if (fs.existsSync(indexPath)) {
          let template = fs.readFileSync(indexPath, 'utf-8');
          template = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
        } else next();
      } catch (e) {
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`APK AI Studio server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => console.error('Failed to start server:', err));
