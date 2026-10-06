import { generateContent, getStoredApiKey } from './geminiClient';

export interface ManifestOperation {
  op:
    | 'replace'
    | 'set_attr'
    | 'remove_permission'
    | 'add_permission'
    | 'set_package'
    | 'set_version'
    | 'set_label'
    | 'append_xml'
    | 'unsupported';
  before?: string;
  after?: string;
  attr?: string;
  value?: string;
  permission?: string;
  reason?: string;
  targetFile?: string;
}

export interface UserCommandPlan {
  understood: string;
  canExecute: boolean;
  operations: ManifestOperation[];
  reply: string;
  needsBuild?: boolean;
  openTool?: 'build' | 'add_app' | 'strip_ads' | 'none';
  intent?:
    | 'question'
    | 'manifest'
    | 'metadata'
    | 'dex'
    | 'resource'
    | 'security'
    | 'build'
    | 'ui'
    | 'unsupported';
}

export interface AppliedOpResult {
  op: string;
  success: boolean;
  note: string;
  beforeSnippet?: string;
  afterSnippet?: string;
}

/**
 * Convert free-form user instruction into concrete AndroidManifest operations via Gemini.
 * Package rename is NOT offered as a safe op (incomplete across DEX/resources).
 */
export async function geminiExecuteUserCommand(
  userCommand: string,
  apkContext: string,
  currentManifestXml: string
): Promise<UserCommandPlan> {
  if (!getStoredApiKey()) {
    throw new Error(
      'برای اجرای دستور آزاد، کلید Gemini را در تنظیمات وارد کنید. بدون کلید فقط دستورهای آماده کار می‌کنند.'
    );
  }

  const system = `تو موتور اجرای دستور در APK AI Studio هستی.
دستور کاربر را بفهم و فقط به عملیات واقعاً قابل‌اجرا روی AndroidManifest تبدیل کن.

ممنوع: set_package / تغییر package name کامل (چون DEX و resourceها را پوشش نمی‌دهیم).
اگر کاربر package خواست: canExecute=false و در reply توضیح بده.

فقط JSON معتبر:
{
  "understood": "خلاصه فارسی",
  "canExecute": true,
  "intent": "manifest",
  "operations": [
    { "op": "set_attr", "attr": "usesCleartextTraffic", "value": "false", "targetFile": "AndroidManifest.xml" },
    { "op": "remove_permission", "permission": "android.permission.CAMERA", "targetFile": "AndroidManifest.xml" },
    { "op": "add_permission", "permission": "android.permission.INTERNET" },
    { "op": "set_version", "value": "2.0" },
    { "op": "set_label", "value": "نام جدید" },
    { "op": "replace", "before": "متن دقیق از منیفست", "after": "جایگزین" }
  ],
  "reply": "توضیح کوتاه",
  "needsBuild": true,
  "openTool": "none"
}

intent: question | manifest | metadata | dex | resource | security | build | ui | unsupported
اگر فقط سؤال است: canExecute=false و operations=[].
اگر عملیات خارج از Manifest/امنیت ساده است و ابزار نداریم: intent=unsupported، canExecute=false.
before را فقط از متن واقعی منیفست بردار.`;

  const prompt = `دستور کاربر:\n"""\n${userCommand}\n"""\n\nبافت APK:\n${apkContext}\n\nAndroidManifest فعلی:\n\`\`\`xml\n${(currentManifestXml || '').slice(0, 12000)}\n\`\`\`\n\nJSON عملیات:`;

  const text = await generateContent({
    contents: prompt,
    systemInstruction: system,
    temperature: 0.15,
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
  });

  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as UserCommandPlan;
    const ops = Array.isArray(parsed.operations) ? parsed.operations : [];
    // Strip unsafe package ops
    const safeOps = ops.filter((o) => o.op !== 'set_package');
    if (ops.some((o) => o.op === 'set_package')) {
      return {
        understood: parsed.understood || userCommand,
        canExecute: false,
        operations: [],
        reply:
          (parsed.reply || '') +
          '\n\n❌ تغییر package name در این نسخه پشتیبانی کامل ندارد (DEX/resource). APK خراب تولید نمی‌شود.',
        needsBuild: false,
        openTool: 'none',
        intent: 'unsupported',
      };
    }
    return {
      understood: parsed.understood || userCommand,
      canExecute: !!parsed.canExecute && safeOps.length > 0,
      operations: safeOps,
      reply: parsed.reply || text,
      needsBuild: !!parsed.needsBuild,
      openTool: parsed.openTool || 'none',
      intent: parsed.intent || 'manifest',
    };
  } catch {
    return {
      understood: userCommand,
      canExecute: false,
      operations: [],
      reply: text,
      needsBuild: false,
      openTool: 'none',
      intent: 'question',
    };
  }
}

function verifyAttr(xml: string, attr: string, value: string): boolean {
  const re = new RegExp(`android:${attr}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
  return re.test(xml);
}

export function applyManifestOperations(
  xml: string,
  operations: ManifestOperation[]
): {
  xml: string;
  notes: string[];
  meta: { name?: string; packageName?: string; versionName?: string };
  results: AppliedOpResult[];
  anySuccess: boolean;
} {
  let out = xml || '';
  const notes: string[] = [];
  const results: AppliedOpResult[] = [];
  const meta: { name?: string; packageName?: string; versionName?: string } = {};

  const setAttr = (attr: string, value: string) => {
    const re = new RegExp('android:' + attr + '="[^"]*"', 'g');
    if (re.test(out)) {
      out = out.replace(re, 'android:' + attr + '="' + value + '"');
    } else if (/<application\b/.test(out)) {
      out = out.replace(/<application\b([^>]*)/, '<application$1 android:' + attr + '="' + value + '"');
    }
  };

  for (const op of operations) {
    const beforeXml = out;
    try {
      switch (op.op) {
        case 'set_package':
          results.push({
            op: 'set_package',
            success: false,
            note: 'تغییر package name کامل پشتیبانی نمی‌شود — رد شد',
          });
          notes.push('❌ تغییر package رد شد');
          break;

        case 'replace':
          if (op.before && out.includes(op.before)) {
            out = out.replace(op.before, op.after || '');
            const ok = !out.includes(op.before) || (op.after || '') === op.before;
            const success = out !== beforeXml;
            results.push({
              op: 'replace',
              success,
              note: success ? 'جایگزینی متن' : 'جایگزینی اثر نداشت',
              beforeSnippet: op.before.slice(0, 80),
              afterSnippet: (op.after || '').slice(0, 80),
            });
            notes.push(success ? '✅ جایگزینی متن' : '❌ جایگزینی ناموفق');
          } else {
            results.push({ op: 'replace', success: false, note: 'متن before در منیفست پیدا نشد' });
            notes.push('❌ متن replace پیدا نشد');
          }
          break;

        case 'set_attr':
          if (op.attr) {
            setAttr(op.attr, op.value ?? 'false');
            const success = verifyAttr(out, op.attr, op.value ?? 'false');
            results.push({
              op: 'set_attr',
              success,
              note: success
                ? `${op.attr}=${op.value ?? 'false'}`
                : `اعمال ${op.attr} تأیید نشد`,
            });
            notes.push(success ? `✅ ${op.attr}=${op.value ?? 'false'}` : `❌ ${op.attr} اعمال نشد`);
          }
          break;

        case 'remove_permission':
          if (op.permission) {
            const esc = op.permission.replace(/\./g, '\\.');
            const re = new RegExp(
              '\\s*<uses-permission[^>]*android:name="' + esc + '"[^>]*/>',
              'gi'
            );
            out = out.replace(re, '');
            const success = !out.includes(op.permission) || out !== beforeXml;
            const reallyGone = !new RegExp(`android:name="${esc}"`, 'i').test(out);
            results.push({
              op: 'remove_permission',
              success: reallyGone || out !== beforeXml,
              note: reallyGone || out !== beforeXml ? 'حذف ' + op.permission : 'مجوز نبود یا حذف نشد',
            });
            notes.push(
              reallyGone || out !== beforeXml ? `✅ حذف ${op.permission}` : `❌ مجوز نبود`
            );
          }
          break;

        case 'add_permission':
          if (op.permission && !out.includes(op.permission)) {
            const tag = '    <uses-permission android:name="' + op.permission + '" />\n';
            if (/<application\b/.test(out)) {
              out = out.replace(/<application\b/, tag + '<application');
            } else {
              out += '\n' + tag;
            }
            const success = out.includes(op.permission);
            results.push({
              op: 'add_permission',
              success,
              note: success ? 'افزودن ' + op.permission : 'افزودن ناموفق',
            });
            notes.push(success ? `✅ افزودن ${op.permission}` : '❌ افزودن مجوز ناموفق');
          } else if (op.permission) {
            results.push({ op: 'add_permission', success: true, note: 'مجوز از قبل موجود بود' });
            notes.push('ℹ️ مجوز از قبل بود');
          }
          break;

        case 'set_version':
          if (op.value) {
            if (/android:versionName="[^"]*"/.test(out)) {
              out = out.replace(/android:versionName="[^"]*"/, 'android:versionName="' + op.value + '"');
            }
            out = out.replace(/android:versionCode="(\d+)"/, (_m, n) => {
              return 'android:versionCode="' + String(parseInt(n, 10) + 1) + '"';
            });
            meta.versionName = op.value;
            const success = out.includes(`android:versionName="${op.value}"`);
            results.push({
              op: 'set_version',
              success,
              note: success ? 'versionName=' + op.value : 'نسخه اعمال نشد',
            });
            notes.push(success ? `✅ versionName=${op.value}` : '❌ نسخه اعمال نشد');
          }
          break;

        case 'set_label':
          if (op.value) {
            if (/android:label="[^"]*"/.test(out)) {
              out = out.replace(/android:label="[^"]*"/, 'android:label="' + op.value + '"');
            } else if (/<application\b/.test(out)) {
              out = out.replace(/<application\b([^>]*)/, '<application$1 android:label="' + op.value + '"');
            }
            meta.name = op.value;
            const success = out.includes(`android:label="${op.value}"`);
            results.push({
              op: 'set_label',
              success,
              note: success ? 'label=' + op.value : 'نام اعمال نشد',
            });
            notes.push(success ? `✅ label=${op.value}` : '❌ نام اعمال نشد');
          }
          break;

        case 'append_xml':
          if (op.after) {
            if (/<application\b/.test(out)) {
              out = out.replace(/<application\b/, op.after + '<application');
            } else {
              out += '\n' + op.after;
            }
            const success = out !== beforeXml;
            results.push({ op: 'append_xml', success, note: success ? 'XML اضافه شد' : 'append بی‌اثر' });
            notes.push(success ? '✅ XML اضافه شد' : '❌ append ناموفق');
          }
          break;

        case 'unsupported':
          results.push({
            op: 'unsupported',
            success: false,
            note: op.reason || 'عملیات در موتور فعلی قابل اجرا نیست',
          });
          notes.push('❌ ' + (op.reason || 'پشتیبانی نمی‌شود'));
          break;

        default:
          results.push({ op: String(op.op), success: false, note: 'عملیات ناشناخته' });
          notes.push('❌ عملیات ناشناخته');
          break;
      }
    } catch {
      results.push({ op: String(op.op), success: false, note: 'خطا در اجرای عملیات' });
      notes.push('❌ خطا در یک عملیات');
    }
  }

  const anySuccess = results.some((r) => r.success);
  return { xml: out, notes, meta, results, anySuccess };
}
