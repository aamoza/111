import React, { useState } from 'react';
import { ApkProject } from '../types/apk';
import { buildAndSignApk, KeystoreConfig } from '../utils/apkSigner';
import { saveOrDownloadApk } from '../utils/downloadHelper';
import { nativeSignApk } from '../plugins/ApkSignerPlugin';
import {
  Hammer,
  CheckCircle2,
  Download,
  AlertTriangle,
  Loader2,
  Sparkles,
  Key,
  Share2,
  ShieldCheck,
} from 'lucide-react';
import JSZip from 'jszip';

interface BuildViewProps {
  project: ApkProject;
  zip: JSZip | null;
  onAddLog: (type: any, message: string) => void;
  onAskAiAboutError?: (errMessage: string) => void;
  onOpenGitHubWorkflow?: () => void;
}

export const BuildView: React.FC<BuildViewProps> = ({
  project,
  zip,
  onAddLog,
  onAskAiAboutError,
  onOpenGitHubWorkflow,
}) => {
  const [isBuilding, setIsBuilding] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, text: '' });
  const [builtApk, setBuiltApk] = useState<{
    blob: Blob;
    fileName: string;
    signedSha256: string;
    nativeSigned: boolean;
    appliedManifest?: boolean;
    adHits?: number;
  } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [alias, setAlias] = useState('apkaistudio-release');
  const [org, setOrg] = useState('APK AI Studio Authorized');

  const pendingChanges = (project.changes || []).filter((c) => c.status === 'applied');
  const hasStagedManifest = pendingChanges.some(
    (c) =>
      c.filePath === 'AndroidManifest.xml' ||
      /manifest|منیفست|پچ امن|اصلاح|تبلیغ|نسخه|پکیج|label|مجوز/i.test(c.descriptionFa || '')
  );

  const handleStartBuild = async () => {
    setIsBuilding(true);
    setBuildError(null);
    setBuiltApk(null);
    setSaveMessage(null);

    try {
      if (!zip) {
        throw new Error(
          'APK اصلی در حافظه نیست. از لیست برنامه‌های نصب‌شده یا از Downloads یک APK واقعی وارد کنید.'
        );
      }

      const keystore: KeystoreConfig = {
        alias: alias.trim() || 'apkaistudio-release',
        organization: org.trim() || 'APK AI Studio Release',
        commonName: project.name,
      };

      setProgress({
        percent: 10,
        text: hasStagedManifest
          ? 'اعمال تغییرات چت روی منیفست (Binary AXML)...'
          : 'کپی باینری APK اصلی...',
      });
      const result = await buildAndSignApk(
        project,
        zip,
        new Map(),
        keystore,
        (percent, text) => {
          setProgress({ percent: Math.min(55, Math.round(percent * 0.55)), text });
        }
      );

      setProgress({ percent: 60, text: 'امضای Google apksig روی گوشی (اجباری)...' });
      const signed = await nativeSignApk(result.blob, result.fileName);

      if (!signed.usedNative) {
        throw new Error(
          'پلاگین امضای native در این نسخه APK فعال نیست. آخرین Artifact موفق GitHub Actions را نصب کنید (باید برچسب apksig native ببینید). بدون آن اندروید بسته را قبول نمی‌کند.'
        );
      }

      setProgress({ percent: 95, text: 'امضای native موفق' });

      const hashBuf = await crypto.subtle.digest('SHA-256', await signed.blob.arrayBuffer());
      const signedSha256 = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      setBuiltApk({
        blob: signed.blob,
        fileName: signed.fileName,
        signedSha256,
        nativeSigned: true,
        appliedManifest: result.appliedManifest,
        adHits: result.adHits,
      });
      setProgress({ percent: 100, text: 'تمام — قابل نصب' });
      onAddLog(
        'build',
        `APK امضا شد: ${signed.fileName}` +
          (result.appliedManifest ? ' · منیفست باینری اعمال شد' : '') +
          (result.adHits ? ` · ${result.adHits} host تبلیغ خنثی` : '')
      );
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'خطای نامشخص';
      setBuildError(msg);
      onAddLog('error', `خطای ساخت: ${msg}`);
    } finally {
      setIsBuilding(false);
    }
  };

  const handleDownload = async () => {
    if (!builtApk || isSaving) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const result = await saveOrDownloadApk(builtApk.blob, builtApk.fileName);
      setSaveMessage(result.message);
      if (result.ok) onAddLog('build', result.message);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveMessage('خطا: ' + msg);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-xl font-bold text-white tracking-tight">ساخت APK قابل نصب</h1>
        <p className="text-xs text-slate-400 mt-1">
          تغییرات چت/امنیت روی منیفست به‌صورت Binary AXML داخل APK نوشته می‌شوند؛ بعد META-INF پاک و با
          Google apksig امضا می‌شود.
        </p>
      </div>

      {!zip && (
        <div className="p-4 rounded-2xl border border-amber-500/40 bg-amber-950/30 text-amber-100 text-xs leading-relaxed">
          <AlertTriangle className="w-4 h-4 inline-block ml-1 text-amber-400" />
          هنوز APK واقعی در حافظه نیست. از «برنامه‌های نصب‌شده» یا انتخاب فایل از Downloads یک APK وارد
          کنید، بعد بیلد بزنید.
        </div>
      )}

      {hasStagedManifest && (
        <div className="p-4 rounded-2xl border border-sky-500/40 bg-sky-950/30 text-sky-100 text-xs leading-relaxed">
          <CheckCircle2 className="w-4 h-4 inline-block ml-1 text-sky-400" />
          {pendingChanges.length} تغییر ثبت‌شده آماده بیلد است — با زدن «ساخت» داخل APK اعمال می‌شوند.
        </div>
      )}

      <div className="p-4 rounded-2xl border border-slate-800 bg-slate-900/40">
        <span className="text-xs text-slate-400 block mb-2 font-semibold">مراحل واقعی:</span>
        <div className="flex items-center justify-between gap-2 overflow-x-auto text-xs font-mono py-1">
          {[
            '۱. کپی باینری',
            '۲. منیفست AXML',
            '۳. حذف META-INF',
            '۴. apksig',
            '۵. حذف نسخه قبلی + نصب',
          ].map((step, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 p-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 shrink-0"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>{step}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center gap-2.5">
          <Key className="w-5 h-5 text-emerald-400" />
          <div>
            <h3 className="text-sm font-semibold text-white">کلید امضا (داخل گوشی)</h3>
            <p className="text-xs text-slate-400 mt-0.5">با کلید فروشگاه فرق دارد → نسخه قبلی همان پکیج را حذف کنید.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-2">
          <div>
            <label className="block text-slate-400 mb-1">Key Alias:</label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              disabled={isBuilding}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">سازمان:</label>
            <input
              type="text"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              disabled={isBuilding}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      <div className="p-6 rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 text-center space-y-4">
        <button
          onClick={handleStartBuild}
          disabled={isBuilding || !zip}
          className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-sm transition-all shadow-lg shadow-emerald-500/20 cursor-pointer inline-flex items-center gap-2"
        >
          {isBuilding ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>در حال ساخت...</span>
            </>
          ) : (
            <>
              <Hammer className="w-5 h-5" />
              <span>ساخت و امضای قابل نصب</span>
            </>
          )}
        </button>

        {isBuilding && (
          <div className="max-w-md mx-auto space-y-2 pt-2">
            <div className="flex items-center justify-between text-xs text-slate-300 font-mono">
              <span>{progress.text}</span>
              <span>{progress.percent}٪</span>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="p-5 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-emerald-500/20 text-emerald-400 shrink-0">
            <Sparkles className="w-6 h-6" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white">GitHub Actions</h4>
            <p className="text-xs text-slate-400 mt-0.5">آخرین Artifact را نصب کنید تا پلاگین ApkSigner باشد</p>
          </div>
        </div>
        <button
          onClick={onOpenGitHubWorkflow}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
        >
          راهنما
        </button>
      </div>

      {buildError && (
        <div className="p-4 rounded-2xl border border-rose-500/30 bg-rose-950/40 text-rose-200 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>خطا در ساخت</span>
          </div>
          <p className="text-xs leading-relaxed">{buildError}</p>
          {onAskAiAboutError && (
            <button
              onClick={() => onAskAiAboutError(buildError)}
              className="px-3 py-1.5 rounded-lg bg-rose-900/60 border border-rose-500/40 text-white text-xs font-medium cursor-pointer flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              تحلیل با AI
            </button>
          )}
        </div>
      )}

      {builtApk && builtApk.nativeSigned && (
        <div className="p-5 rounded-2xl border-2 border-emerald-500/40 bg-slate-900/90 shadow-2xl space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
              <h3 className="text-sm font-bold text-white">APK آماده نصب</h3>
            </div>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-mono flex items-center gap-1 bg-emerald-500/20 text-emerald-300">
              <ShieldCheck className="w-3.5 h-3.5" />
              apksig native
            </span>
          </div>

          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">فایل:</span>
              <span className="text-emerald-300 font-bold">{builtApk.fileName}</span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">حجم:</span>
              <span>{(builtApk.blob.size / (1024 * 1024)).toFixed(2)} MB</span>
            </div>
            {builtApk.appliedManifest && (
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-400">منیفست:</span>
                <span className="text-sky-300">Binary AXML اعمال شد</span>
              </div>
            )}
          </div>

          <p className="text-[11px] text-emerald-200/90 leading-relaxed">
            ۱) ذخیره در Downloads
            <br />
            ۲) نسخه قبلی همین پکیج را از گوشی حذف کن (امضا فرق دارد)
            <br />
            ۳) فایل جدید را نصب کن
          </p>

          {saveMessage && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/40 text-xs text-emerald-100 whitespace-pre-wrap">
              {saveMessage}
            </div>
          )}

          <button
            onClick={handleDownload}
            disabled={isSaving}
            className="w-full px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-sm font-bold cursor-pointer flex items-center justify-center gap-2"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                ذخیره...
              </>
            ) : (
              <>
                <Download className="w-5 h-5" />
                ذخیره در Downloads
              </>
            )}
          </button>
          <p className="text-[11px] text-slate-400 text-center flex items-center justify-center gap-1">
            <Share2 className="w-3.5 h-3.5" />
            Files → Downloads → نصب
          </p>
        </div>
      )}
    </div>
  );
};
