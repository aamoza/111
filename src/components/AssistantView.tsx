import React, { useState, useRef, useEffect } from 'react';
import { ApkProject } from '../types/apk';
import { buildRichApkContext } from '../utils/apkContextHelper';
import { getStoredApiKey } from '../utils/geminiClient';
import { buildLocalSuggestions, suggestionsToAssistantText } from '../utils/suggestionsEngine';
import { parseChatCommands } from '../utils/chatCommandEngine';
import { applyActionsToManifest } from '../utils/chatCommandEngine';
import {
  geminiExecuteUserCommand,
  applyManifestOperations,
} from '../utils/commandExecutor';
import {
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  Copy,
  Check,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Hammer,
  Upload,
  Wrench,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface AssistantViewProps {
  project: ApkProject;
  initialPrompt?: string;
  onClearInitialPrompt?: () => void;
  onOpenInstalledApps?: () => void;
  onApplyHardening?: () => void;
  onGoToBuild?: () => void;
  onOpenAdStripper?: () => void;
  onApplyChatPatch?: (payload: {
    xml: string;
    name?: string;
    packageName?: string;
    versionName?: string;
    description: string;
  }) => void;
}

export const AssistantView: React.FC<AssistantViewProps> = ({
  project,
  initialPrompt,
  onClearInitialPrompt,
  onOpenInstalledApps,
  onApplyHardening,
  onGoToBuild,
  onOpenAdStripper,
  onApplyChatPatch,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = useState(initialPrompt || '');
  const [isSending, setIsSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const welcomeDone = useRef<string | null>(null);

  useEffect(() => {
    if (welcomeDone.current === project.id) return;
    welcomeDone.current = project.id;
    const suggestions = buildLocalSuggestions(project);
    const analysis = suggestionsToAssistantText(suggestions, project.name);
    const hasKey = !!getStoredApiKey();

    setMessages([
      {
        id: `welcome_${project.id}`,
        role: 'assistant',
        content:
          'سلام! روی **' +
          project.name +
          '** هستم.\n' +
          '`' +
          project.manifest.packageName +
          '` · امتیاز **' +
          project.securityReport.score +
          '/100**\n\n' +
          analysis +
          '\n\n' +
          (hasKey
            ? 'کلید Gemini فعال است. دستورهای Manifest/امنیت واقعاً اعمال و تأیید می‌شوند. برای APK نهایی «بیلد» بزن (منیفست باینری اصلی حفظ می‌شود + پچ امنیتی درجا).'
            : 'بدون کلید فقط دکمه‌ها و دستورهای ساده محلی کار می‌کنند. کلید را در تنظیمات بگذار.'),
        timestamp: Date.now(),
      },
    ]);
  }, [project]);

  useEffect(() => {
    if (initialPrompt) {
      setInputPrompt(initialPrompt);
      onClearInitialPrompt?.();
    }
  }, [initialPrompt, onClearInitialPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  const openTool = (tool?: string) => {
    if (tool === 'build') onGoToBuild?.();
    if (tool === 'add_app') onOpenInstalledApps?.();
    if (tool === 'strip_ads') onOpenAdStripper?.();
  };

  const handleSendMessage = async (textToSend?: string) => {
    const prompt = (textToSend || inputPrompt).trim();
    if (!prompt || isSending) return;

    setMessages((prev) => [
      ...prev,
      { id: `user_${Date.now()}`, role: 'user', content: prompt, timestamp: Date.now() },
    ]);
    setInputPrompt('');

    const localActions = parseChatCommands(prompt);
    const hasLocalExecutable = localActions.some((a) => a.type !== 'unknown');
    const isSimplePreset =
      hasLocalExecutable &&
      localActions.every((a) =>
        ['add_app', 'build', 'strip_ads', 'harden', 'analyze'].includes(a.type)
      );

    // Reject package rename early (incomplete across DEX)
    if (/پکیج|package\s*name|applicationId/i.test(prompt) && /تغییر|عوض|کن|set|rename/i.test(prompt)) {
      setMessages((prev) => [
        ...prev,
        {
          id: `rej_${Date.now()}`,
          role: 'assistant',
          content:
            '❌ تغییر package name در این نسخه پشتیبانی کامل ندارد (DEX و resourceها). برای جلوگیری از APK خراب، این دستور اجرا نمی‌شود.',
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    if (isSimplePreset && !getStoredApiKey()) {
      const lines: string[] = [];
      const patchable = localActions.filter((a) =>
        ['harden', 'set_flag', 'set_label', 'set_version', 'remove_permission', 'add_permission'].includes(
          a.type
        )
      );
      if (patchable.length) {
        const result = applyActionsToManifest(project.manifest?.rawXmlText || '', patchable);
        const changed = result.xml !== (project.manifest?.rawXmlText || '');
        if (changed && result.notes.length) {
          onApplyChatPatch?.({
            xml: result.xml,
            name: result.name,
            packageName: result.packageName,
            versionName: result.versionName,
            description: result.notes.join('؛ '),
          });
          if (patchable.some((a) => a.type === 'harden')) onApplyHardening?.();
          lines.push('✅ تأیید شد:\n• ' + result.notes.join('\n• '));
          lines.push('\nبرای اعمال روی فایل باینری APK: بیلد کن (پچ امنیتی درجا روی AXML اصلی).');
        } else {
          lines.push('❌ تغییر روی منیفست اعمال/تأیید نشد.');
        }
      }
      for (const a of localActions) {
        if (a.type === 'add_app') {
          onOpenInstalledApps?.();
          lines.push('✅ پنل APK باز شد');
        }
        if (a.type === 'build') {
          onGoToBuild?.();
          lines.push('✅ صفحه ساخت باز شد');
        }
        if (a.type === 'strip_ads') {
          onOpenAdStripper?.();
          lines.push('✅ ابزار تبلیغات باز شد');
        }
        if (a.type === 'analyze') {
          lines.push(suggestionsToAssistantText(buildLocalSuggestions(project), project.name));
        }
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `local_${Date.now()}`,
          role: 'assistant',
          content: lines.join('\n') || '❌ عملیاتی انجام نشد',
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    setIsSending(true);
    try {
      // Local deterministic first when no need for Gemini
      const localPatchTypes = localActions.filter((a) =>
        ['harden', 'set_flag', 'set_label', 'set_version', 'remove_permission', 'add_permission'].includes(
          a.type
        )
      );
      if (localPatchTypes.length && !/\?|چیست|چرا|توضیح|explain/i.test(prompt)) {
        const result = applyActionsToManifest(project.manifest?.rawXmlText || '', localPatchTypes);
        const changed = result.xml !== (project.manifest?.rawXmlText || '');
        if (changed) {
          onApplyChatPatch?.({
            xml: result.xml,
            name: result.name,
            versionName: result.versionName,
            description: result.notes.join('؛ '),
          });
          if (localPatchTypes.some((a) => a.type === 'harden')) onApplyHardening?.();
        }
        for (const a of localActions) {
          if (a.type === 'build') onGoToBuild?.();
          if (a.type === 'add_app') onOpenInstalledApps?.();
          if (a.type === 'strip_ads') onOpenAdStripper?.();
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `loc2_${Date.now()}`,
            role: 'assistant',
            content: changed
              ? '✅ تأیید شد:\n• ' +
                result.notes.join('\n• ') +
                '\n\nبیلد کن تا روی Binary AXML اصلی پچ امنیتی اعمال شود.'
              : '❌ تغییر اعمال نشد؛ مقدار/مجوز موردنظر پیدا نشد یا از قبل درست بود.',
            timestamp: Date.now(),
          },
        ]);
        setIsSending(false);
        return;
      }

      const apkContext = buildRichApkContext(project);
      const plan = await geminiExecuteUserCommand(
        prompt,
        apkContext,
        project.manifest?.rawXmlText || ''
      );

      const parts: string[] = [];
      parts.push('📝 فهمیدم: ' + plan.understood);
      if (plan.reply) parts.push(plan.reply);

      if (plan.canExecute && plan.operations.length > 0) {
        const applied = applyManifestOperations(
          project.manifest?.rawXmlText || '',
          plan.operations
        );

        if (applied.anySuccess) {
          onApplyChatPatch?.({
            xml: applied.xml,
            name: applied.meta.name,
            packageName: applied.meta.packageName,
            versionName: applied.meta.versionName,
            description: plan.understood + ' | ' + applied.notes.join('؛ '),
          });
          parts.push('');
          parts.push('نتیجه تأییدشده:');
          applied.notes.forEach((n) => parts.push('• ' + n));
          if (plan.needsBuild) {
            parts.push('');
            parts.push(
              'برای APK قابل نصب: «بیلد کن» — منیفست باینری اصلی حفظ می‌شود و hardening به‌صورت پچ درجا اعمال می‌گردد.'
            );
          }
        } else {
          parts.push('');
          parts.push('❌ هیچ تغییری روی منیفست تأیید نشد (قبل=بعد یا هدف پیدا نشد).');
          applied.notes.forEach((n) => parts.push('• ' + n));
        }
      } else if (!plan.canExecute) {
        // question or unsupported — reply only, no fake success
        if (!plan.reply) parts.push('این درخواست به‌صورت mutation اجرا نشد.');
      }

      openTool(plan.openTool);

      setMessages((prev) => [
        ...prev,
        {
          id: `exec_${Date.now()}`,
          role: 'assistant',
          content: parts.join('\n'),
          timestamp: Date.now(),
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (hasLocalExecutable) {
        const result = applyActionsToManifest(
          project.manifest?.rawXmlText || '',
          localActions.filter((a) => a.type !== 'unknown' && a.type !== 'analyze' && a.type !== 'set_package')
        );
        const changed = result.xml !== (project.manifest?.rawXmlText || '');
        if (changed && result.notes.length) {
          onApplyChatPatch?.({
            xml: result.xml,
            name: result.name,
            versionName: result.versionName,
            description: result.notes.join('؛ '),
          });
        }
        for (const a of localActions) {
          if (a.type === 'build') onGoToBuild?.();
          if (a.type === 'add_app') onOpenInstalledApps?.();
          if (a.type === 'strip_ads') onOpenAdStripper?.();
          if (a.type === 'harden' && changed) onApplyHardening?.();
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `fb_${Date.now()}`,
            role: 'assistant',
            content:
              '⚠️ Gemini: ' +
              msg +
              (changed
                ? '\n\n✅ دستور محلی تأیید شد:\n• ' + result.notes.join('\n• ')
                : '\n\n❌ دستور محلی هم تغییری اعمال نکرد.'),
            timestamp: Date.now(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content:
              '❌ اجرا نشد:\n' +
              msg +
              '\n\n۱) کلید Gemini در تنظیمات\n۲) دستور ساده‌تر\n۳) دکمه‌های آماده',
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleCopy = (id: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[520px] rounded-2xl border border-slate-800 bg-slate-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">دستیار · {project.name}</h2>
            <p className="text-[11px] text-slate-400 font-mono truncate max-w-[220px]">
              {project.manifest.packageName}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            welcomeDone.current = null;
            setMessages([
              {
                id: `reset_${Date.now()}`,
                role: 'assistant',
                content: suggestionsToAssistantText(buildLocalSuggestions(project), project.name),
                timestamp: Date.now(),
              },
            ]);
          }}
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-slate-800/80 bg-slate-900/40">
        <button type="button" onClick={() => handleSendMessage('اصلاح کن')} className="px-2.5 py-1 rounded-lg text-[11px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
          <ShieldCheck className="w-3 h-3" /> اصلاح
        </button>
        <button type="button" onClick={() => handleSendMessage('بیلد کن')} className="px-2.5 py-1 rounded-lg text-[11px] bg-sky-500/15 text-sky-300 border border-sky-500/30 flex items-center gap-1">
          <Hammer className="w-3 h-3" /> بیلد
        </button>
        <button type="button" onClick={() => handleSendMessage('اضافه کردن برنامه')} className="px-2.5 py-1 rounded-lg text-[11px] bg-violet-500/15 text-violet-300 border border-violet-500/30 flex items-center gap-1">
          <Upload className="w-3 h-3" /> APK
        </button>
        <button type="button" onClick={() => handleSendMessage('حذف تبلیغ')} className="px-2.5 py-1 rounded-lg text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> تبلیغ
        </button>
        <button type="button" onClick={() => handleSendMessage('تحلیل کن')} className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-700/50 text-slate-300 border border-slate-600 flex items-center gap-1">
          <Sparkles className="w-3 h-3" /> تحلیل
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-emerald-400" />
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white rounded-br-md'
                  : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-md'
              }`}
            >
              {m.content}
              {m.role === 'assistant' && (
                <button
                  type="button"
                  onClick={() => handleCopy(m.id, m.content)}
                  className="mt-1 text-[10px] text-slate-500 hover:text-slate-300 inline-flex items-center gap-1"
                >
                  {copiedId === m.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  کپی
                </button>
              )}
            </div>
            {m.role === 'user' && (
              <div className="w-7 h-7 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-slate-300" />
              </div>
            )}
          </div>
        ))}
        {isSending && (
          <div className="flex items-center gap-2 text-slate-400 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" />
            در حال فهم، اجرا و تأیید...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-slate-800 bg-slate-900/60">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="دستور واقعی — فقط در صورت تأیید mutation، موفقیت نشان داده می‌شود"
            disabled={isSending}
            className="flex-1 px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            onClick={() => handleSendMessage()}
            disabled={isSending || !inputPrompt.trim()}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold"
          >
            {isSending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        </div>
        <p className="text-[10px] text-slate-500 mt-1.5 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          موفقیت فقط بعد از verification — بیلد منیفست باینری اصلی را حفظ می‌کند
        </p>
      </div>
    </div>
  );
};
