import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Shield,
  Moon,
  Sun,
  Lock,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Key,
  Eye,
  EyeOff,
  Save,
  Trash2,
} from 'lucide-react';
import {
  checkGeminiStatus,
  getStoredApiKey,
  setStoredApiKey,
  clearStoredApiKey,
  invalidateModelCache,
  type GeminiStatus,
} from '../utils/geminiClient';

interface SettingsViewProps {
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  allowAiDataSharing: boolean;
  onToggleAiDataSharing: (val: boolean) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  isDarkMode,
  onToggleDarkMode,
  allowAiDataSharing,
  onToggleAiDataSharing,
}) => {
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<GeminiStatus>({
    configured: false,
    connected: false,
    message: 'وضعیت بررسی نشده است.',
  });

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const existing = getStoredApiKey();
    if (existing) {
      setApiKeyInput(existing);
      setKeySaved(true);
    }
    runStatusCheck();
  }, []);

  const runStatusCheck = async () => {
    setTestingConnection(true);
    try {
      invalidateModelCache();
      const status = await checkGeminiStatus();
      setConnectionStatus(status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'خطای شبکه';
      setConnectionStatus({
        configured: false,
        connected: false,
        message: msg,
        source: 'none',
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveKey = async () => {
    setSaving(true);
    try {
      setStoredApiKey(apiKeyInput);
      setKeySaved(!!apiKeyInput.trim());
      await runStatusCheck();
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    clearStoredApiKey();
    setApiKeyInput('');
    setKeySaved(false);
    await runStatusCheck();
  };

  return (
    <div className="space-y-6 pb-12 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-white tracking-tight">تنظیمات و حریم خصوصی (Settings)</h1>
        <p className="text-xs text-slate-400 mt-1">
          پیکربندی کلید Gemini، حریم خصوصی محلی، تم ظاهری و اطلاعات برنامه.
        </p>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400">
            <Key className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">کلید API شخصی Gemini</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              کلید خود را از Google AI Studio بگیرید و اینجا ذخیره کنید. کلید فقط روی دستگاه شما نگه‌داری می‌شود.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                setKeySaved(false);
              }}
              placeholder="AIza..."
              className="w-full px-4 py-2.5 pr-12 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
              dir="ltr"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSaveKey}
              disabled={saving || !apiKeyInput.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              ذخیره کلید
            </button>
            {keySaved && (
              <button
                onClick={handleClearKey}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                حذف کلید
              </button>
            )}
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            کلید از{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:underline"
            >
              aistudio.google.com/apikey
            </a>{' '}
            قابل دریافت است. فقط روی همین دستگاه ذخیره می‌شود و به سرور خارجی ارسال نمی‌گردد.
          </p>
        </div>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">وضعیت اتصال Gemini</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                خودکار بهترین مدل <span className="text-emerald-400">متنی Flash</span> در دسترس را پیدا می‌کند
                (مدل‌های image حذف می‌شوند).
              </p>
            </div>
          </div>

          <button
            onClick={runStatusCheck}
            disabled={testingConnection}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors disabled:opacity-50"
          >
            {testingConnection ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            تست اتصال
          </button>
        </div>

        <div
          className={`flex items-start gap-3 p-3.5 rounded-xl border ${
            connectionStatus.connected
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : connectionStatus.configured
                ? 'border-amber-500/30 bg-amber-500/5'
                : 'border-slate-700 bg-slate-950/50'
          }`}
        >
          {connectionStatus.connected ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : connectionStatus.configured ? (
            <XCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          ) : (
            <Lock className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <p
              className={`text-sm font-medium ${
                connectionStatus.connected
                  ? 'text-emerald-300'
                  : connectionStatus.configured
                    ? 'text-amber-300'
                    : 'text-slate-400'
              }`}
            >
              {connectionStatus.connected
                ? 'متصل'
                : connectionStatus.configured
                  ? 'پیکربندی شده — اتصال ناموفق'
                  : 'کلید تنظیم نشده'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{connectionStatus.message}</p>
            {connectionStatus.model && (
              <p className="text-[11px] text-slate-500 mt-1 font-mono">مدل: {connectionStatus.model}</p>
            )}
            {connectionStatus.source && (
              <p className="text-[11px] text-slate-600 mt-0.5">
                منبع:{' '}
                {connectionStatus.source === 'user-key'
                  ? 'کلید شخصی شما'
                  : connectionStatus.source === 'server'
                    ? 'سرور'
                    : '—'}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">اشتراک داده با هوش مصنوعی</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                تنها متون و کدهایی که شما انتخاب می‌کنید جهت تحلیل به Gemini فرستاده می‌شوند.
              </p>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 mr-4">
            <input
              type="checkbox"
              checked={allowAiDataSharing}
              onChange={(e) => onToggleAiDataSharing(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400">
              {isDarkMode ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">حالت تیره / روشن (Dark / Light Mode)</h3>
              <p className="text-xs text-slate-400 mt-0.5">تنظیم حالت نمایش متناسب با محیط و شرایط نوری.</p>
            </div>
          </div>
          <button
            onClick={onToggleDarkMode}
            className="px-3.5 py-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors cursor-pointer"
          >
            {isDarkMode ? 'تغییر به تم روشن' : 'تغییر به تم تیره'}
          </button>
        </div>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/40 space-y-3 text-xs leading-relaxed text-slate-300">
        <div className="flex items-center gap-2 text-white font-semibold pb-2 border-b border-slate-800">
          <Shield className="w-4 h-4 text-emerald-400" />
          <span>مشخصات برنامه و قوانین استفاده قانونی</span>
        </div>
        <div className="grid grid-cols-2 gap-3 py-1 text-slate-400 font-mono">
          <div>
            نام برنامه: <span className="text-white font-sans font-bold">APK AI Studio</span>
          </div>
          <div>
            نسخه: <span className="text-white">1.3.0</span>
          </div>
          <div>
            Package: <span className="text-white">com.apkaistudio.app</span>
          </div>
          <div>
            مدل AI:{' '}
            <span className="text-emerald-400">
              {connectionStatus.model || 'auto text-flash'}
            </span>
          </div>
        </div>
        <p className="text-slate-500 pt-2">
          این نرم‌افزار برای بررسی‌های امنیتی، تست نفوذ اخلاقی، بازبینی کد و مهندسی معکوس برنامه‌های مجاز توسعه داده شده
          است. استفاده غیرقانونی ممنوع است.
        </p>
      </div>
    </div>
  );
};
