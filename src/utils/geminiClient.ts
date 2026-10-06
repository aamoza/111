/**
 * Unified Gemini client — model discovery + cache + controlled fallback.
 */

const STORAGE_KEY = 'apkaistudio_gemini_api_key';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_GENERATE_ATTEMPTS = 3;

/** Preferred order when ranking discovered models (newest flash first). */
const PREFERRED_NAME_HINTS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-flash',
  'gemini-pro',
];

export function getStoredApiKey(): string {
  try {
    return (localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setStoredApiKey(key: string): void {
  try {
    const cleaned = key.trim();
    if (cleaned) localStorage.setItem(STORAGE_KEY, cleaned);
    else localStorage.removeItem(STORAGE_KEY);
    invalidateModelCache();
  } catch {
    // ignore
  }
}

export function clearStoredApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    invalidateModelCache();
  } catch {
    // ignore
  }
}

export interface GeminiStatus {
  configured: boolean;
  connected: boolean;
  message: string;
  model?: string;
  source?: 'user-key' | 'server' | 'none';
}

interface ModelCache {
  model: string;
  candidates: string[];
  expiresAt: number;
  apiKeyFingerprint: string;
}

let modelCache: ModelCache | null = null;

function fingerprintKey(key: string): string {
  return key.slice(0, 8) + ':' + key.length;
}

export function invalidateModelCache(): void {
  modelCache = null;
}

function classifyApiError(status: number, bodyMsg: string): string {
  const lower = (bodyMsg || '').toLowerCase();
  if (status === 401 || status === 400 || /api.?key|invalid|permission denied|unauthenticated/i.test(lower)) {
    return 'کلید API نامعتبر است یا دسترسی ندارد.';
  }
  if (status === 403 && /quota|rate|limit|resource.?exhausted/i.test(lower)) {
    return 'سقف استفاده (quota) یا محدودیت نرخ درخواست.';
  }
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(lower)) {
    return 'محدودیت نرخ یا quota. کمی بعد دوباره تلاش کنید.';
  }
  if (status === 404 || /not found|is not found/i.test(lower)) {
    return 'مدل در دسترس نیست.';
  }
  if (!status || /failed to fetch|network|offline/i.test(lower)) {
    return 'خطای شبکه یا قطع اینترنت.';
  }
  return bodyMsg || `خطای API (${status})`;
}

interface ListedModel {
  name: string;
  supportedMethods: string[];
}

async function listModels(apiKey: string): Promise<ListedModel[]> {
  const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const raw = errBody?.error?.message || '';
    throw new Error(classifyApiError(res.status, raw));
  }
  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  return models.map((m: { name?: string; supportedGenerationMethods?: string[] }) => ({
    name: (m.name || '').replace(/^models\//, ''),
    supportedMethods: m.supportedGenerationMethods || [],
  }));
}

function rankModels(models: ListedModel[]): string[] {
  const usable = models.filter(
    (m) =>
      m.name &&
      m.supportedMethods.includes('generateContent') &&
      !/embedding|aqa|gecko|vision-only/i.test(m.name)
  );

  const scored = usable.map((m) => {
    let score = 0;
    const n = m.name.toLowerCase();
    PREFERRED_NAME_HINTS.forEach((hint, i) => {
      if (n.includes(hint.replace('gemini-', ''))) score += 100 - i * 10;
    });
    if (n.includes('flash')) score += 20;
    if (n.includes('latest')) score += 15;
    if (n.includes('2.5')) score += 30;
    if (n.includes('2.0')) score += 25;
    if (n.includes('pro') && !n.includes('flash')) score += 5;
    if (n.includes('exp') || n.includes('preview')) score -= 5;
    return { name: m.name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const names = scored.map((s) => s.name);
  // Ensure common aliases tried if present in list
  for (const alias of ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash']) {
    if (names.includes(alias) && names[0] !== alias) {
      // already ranked
    }
  }
  return names.length ? names : ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash'];
}

/**
 * Resolve best available Gemini model for generateContent.
 * Caches result with TTL; invalidate on failure.
 */
export async function resolveBestGeminiModel(apiKey?: string): Promise<{ model: string; candidates: string[] }> {
  const key = apiKey || getStoredApiKey();
  if (!key) throw new Error('کلید Gemini یافت نشد. از تنظیمات کلید را وارد کنید.');

  const fp = fingerprintKey(key);
  if (modelCache && modelCache.apiKeyFingerprint === fp && Date.now() < modelCache.expiresAt) {
    return { model: modelCache.model, candidates: modelCache.candidates };
  }

  let candidates: string[];
  try {
    const listed = await listModels(key);
    candidates = rankModels(listed);
  } catch (e) {
    // Discovery failed — still try known aliases (not infinite)
    candidates = ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-pro'];
    const msg = e instanceof Error ? e.message : String(e);
    if (/کلید API نامعتبر|دسترسی ندارد/.test(msg)) throw e;
  }

  if (!candidates.length) {
    throw new Error('هیچ مدل Gemini با قابلیت generateContent در دسترس نیست.');
  }

  modelCache = {
    model: candidates[0],
    candidates,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    apiKeyFingerprint: fp,
  };
  return { model: candidates[0], candidates };
}

export async function checkGeminiStatus(): Promise<GeminiStatus> {
  const userKey = getStoredApiKey();

  if (userKey) {
    try {
      const { model, candidates } = await resolveBestGeminiModel(userKey);
      // Ping resolved model
      const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(userKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'پینگ. فقط یک کلمه: متصل' }] }],
          generationConfig: { maxOutputTokens: 16, temperature: 0 },
        }),
      });

      if (res.ok) {
        return {
          configured: true,
          connected: true,
          message: `اتصال برقرار است. مدل: ${model}`,
          model,
          source: 'user-key',
        };
      }

      const errBody = await res.json().catch(() => ({}));
      const raw = errBody?.error?.message || '';
      const classified = classifyApiError(res.status, raw);

      // Try next candidate once
      if (candidates.length > 1 && /مدل|not found|404/i.test(classified + raw)) {
        invalidateModelCache();
        modelCache = {
          model: candidates[1],
          candidates: candidates.slice(1),
          expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
          apiKeyFingerprint: fingerprintKey(userKey),
        };
        return checkGeminiStatus();
      }

      return {
        configured: true,
        connected: false,
        message: classified,
        model,
        source: 'user-key',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'خطای شبکه';
      return {
        configured: true,
        connected: false,
        message: msg,
        source: 'user-key',
      };
    }
  }

  try {
    const res = await fetch('/api/gemini/status');
    if (res.ok) {
      const data = await res.json();
      return {
        configured: !!data.configured,
        connected: !!data.connected,
        message: data.model
          ? `${data.message || (data.connected ? 'متصل' : 'قطع')} · مدل: ${data.model}`
          : data.message || (data.connected ? 'متصل' : 'قطع'),
        model: data.model,
        source: data.configured ? 'server' : 'none',
      };
    }
  } catch {
    // server not available
  }

  return {
    configured: false,
    connected: false,
    message: 'کلید Gemini تنظیم نشده است. از بخش تنظیمات کلید شخصی خود را وارد کنید.',
    source: 'none',
  };
}

export interface GenerateOptions {
  contents: string | Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction?: string;
  temperature?: number;
  responseMimeType?: string;
  maxOutputTokens?: number;
}

export async function generateContent(options: GenerateOptions): Promise<string> {
  const userKey = getStoredApiKey();
  if (userKey) return generateWithUserKey(userKey, options);
  throw new Error(
    'کلید Gemini یافت نشد. لطفاً از منوی تنظیمات، کلید API شخصی خود را وارد و ذخیره کنید.'
  );
}

async function generateWithUserKey(apiKey: string, options: GenerateOptions): Promise<string> {
  const { candidates } = await resolveBestGeminiModel(apiKey);
  let lastError = '';

  let contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  if (typeof options.contents === 'string') {
    contents = [{ role: 'user', parts: [{ text: options.contents }] }];
  } else {
    contents = options.contents;
  }

  const bodyBase: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
    },
  };
  if (options.systemInstruction) {
    bodyBase.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }
  if (options.responseMimeType) {
    (bodyBase.generationConfig as Record<string, unknown>).responseMimeType = options.responseMimeType;
  }

  const tryList = candidates.slice(0, MAX_GENERATE_ATTEMPTS);
  for (let i = 0; i < tryList.length; i++) {
    const model = tryList[i];
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyBase),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const raw = errBody?.error?.message || '';
        lastError = classifyApiError(res.status, raw);
        if (/مدل|not found|404/i.test(lastError + raw) || res.status === 404) {
          invalidateModelCache();
          continue;
        }
        if (/کلید API نامعتبر|quota|محدودیت نرخ/i.test(lastError)) {
          throw new Error(lastError);
        }
        continue;
      }

      const data = await res.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') ||
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        '';

      if (!text) {
        lastError = 'پاسخ خالی از مدل دریافت شد.';
        continue;
      }

      // Promote successful model to cache head
      modelCache = {
        model,
        candidates: [model, ...candidates.filter((c) => c !== model)],
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
        apiKeyFingerprint: fingerprintKey(apiKey),
      };
      return text;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (/کلید API نامعتبر|قطع اینترنت|شبکه|quota/i.test(lastError)) throw e;
    }
  }

  throw new Error(lastError || 'هیچ مدل Gemini پاسخ نداد.');
}

const ASSISTANT_SYSTEM = `تو دستیار ارشد APK AI Studio هستی: مهندس اندروید، تحلیل‌گر امنیت و مشاور بهینه‌سازی اپ.
همیشه فارسی، کوتاه، عملی و دقیق جواب بده.

قوانین اجباری:
1) اگر خطای امنیتی یا باگ در بافت APK هست، صریح بگو.
2) حداقل ۲ پیشنهاد مشخص بده.
3) اگر کاربر خواست اصلاح/بیلد، مراحل دقیق بگو.
4) از ادعای انجام کاری که روی فایل اعمال نشده خودداری کن.
5) فقط روی همین APK تمرکز کن.`;

export async function geminiChat(
  messages: Array<{ role: string; content: string }>,
  apkContext: unknown
): Promise<string> {
  const userKey = getStoredApiKey();

  if (userKey) {
    const systemInstruction =
      ASSISTANT_SYSTEM +
      '\n\nبافت APK فعلی:\n' +
      (typeof apkContext === 'object' ? JSON.stringify(apkContext, null, 2) : String(apkContext || ''));

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    return generateWithUserKey(userKey, {
      contents,
      systemInstruction,
      temperature: 0.35,
    });
  }

  const res = await fetch('/api/gemini/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, apkContext }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `خطای سرور: ${res.status}`);
  }

  const data = await res.json();
  return data.reply || data.text || 'پاسخی دریافت نشد.';
}

export async function geminiAgent(payload: {
  goal: string;
  apkSummary: unknown;
  filesList?: string[];
  step?: string;
}): Promise<Record<string, unknown>> {
  const userKey = getStoredApiKey();

  const prompt = `هدف: "${payload.goal}"
مرحله: ${payload.step || 'بررسی اولیه'}
APK:\n${JSON.stringify(payload.apkSummary || {}, null, 2)}
فایل‌ها:\n${(payload.filesList || []).slice(0, 30).join('\n')}

خروجی JSON:
{
  "finding": "...",
  "affectedFile": "AndroidManifest.xml",
  "proposedDiff": { "before": "...", "after": "..." },
  "explanation": "...",
  "securityImpact": "...",
  "canBuildDirectly": true
}`;

  if (userKey) {
    const text = await generateWithUserKey(userKey, {
      contents: prompt,
      temperature: 0.2,
      responseMimeType: 'application/json',
    });
    try {
      return JSON.parse(text);
    } catch {
      return {
        finding: text,
        affectedFile: 'AndroidManifest.xml',
        proposedDiff: { before: '', after: '' },
        explanation: 'تحلیل انجام شد.',
        securityImpact: '',
        canBuildDirectly: false,
      };
    }
  }

  const res = await fetch('/api/gemini/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `خطای سرور: ${res.status}`);
  }
  return res.json();
}

export async function geminiAnalyze(type: string, context: unknown, prompt?: string): Promise<string> {
  const userKey = getStoredApiKey();
  const systemInstruction = ASSISTANT_SYSTEM;
  const fullPrompt = `نوع: ${type || 'تحلیل'}\nبافت:\n${typeof context === 'object' ? JSON.stringify(context, null, 2) : context}\n\nپرسش:\n${prompt || 'تحلیل جامع با خطاها و پیشنهادها.'}`;

  if (userKey) {
    return generateWithUserKey(userKey, {
      contents: fullPrompt,
      systemInstruction,
      temperature: 0.35,
    });
  }

  const res = await fetch('/api/gemini/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, context, prompt }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `خطای سرور: ${res.status}`);
  }
  const data = await res.json();
  return data.text || 'پاسخی دریافت نشد.';
}

/** @deprecated use resolveBestGeminiModel — kept for imports */
export const LATEST_MODEL = 'gemini-flash-latest';
