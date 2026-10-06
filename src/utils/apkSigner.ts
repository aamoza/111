import JSZip from 'jszip';
import { ApkProject } from '../types/apk';
import { patchDexString } from './dexPatcher';
import { encodeAxml } from './axmlEncoder';

export interface KeystoreConfig {
  alias: string;
  keyPass?: string;
  storePass?: string;
  commonName: string;
  organization: string;
}

/** Same-length ad host replacements keep DEX string pool valid for ART. */
const SAFE_AD_HOST_REPLACEMENTS: Array<[string, string]> = [
  ['googleads.g.doubleclick.net', '0.0.0.0.0.0.0.0.0.0.0.0.0.0'],
  ['pagead2.googlesyndication.com', '0.0.0.0.0.0.0.0.0.0.0.0.0.0.0'],
  ['adservice.google.com', '0.0.0.0.0.0.0.0.0.0'],
  ['graph.facebook.com', '0.0.0.0.0.0.0.0.0'],
  ['api.ad.xiaomi.com', '0.0.0.0.0.0.0.0'],
  ['ads.mopub.com', '0.0.0.0.0.0'],
  ['ad.doubleclick.net', '0.0.0.0.0.0.0.0'],
  ['sdk.appsflyer.com', '0.0.0.0.0.0.0.0'],
  ['adjust.com', '0.0.0.0.0'],
  ['unityads.unity3d.com', '0.0.0.0.0.0.0.0.0.0'],
];

function wantsSafeAdStrip(project: ApkProject): boolean {
  const changes = project.changes || [];
  return changes.some((c) =>
    /تبلیغ|tracker|strip\s*ad|ad\s*strip|حذف.*تبلیغ|آگهی|adstrip/i.test(
      (c.descriptionFa || '') + ' ' + (c.filePath || '') + ' ' + (c.after || '')
    )
  );
}

function hasManifestChanges(project: ApkProject): boolean {
  const changes = project.changes || [];
  return changes.some(
    (c) =>
      c.status === 'applied' &&
      (c.filePath === 'AndroidManifest.xml' ||
        /manifest|منیفست|پچ امن|اصلاح|تبلیغ|نسخه|پکیج|label|مجوز/i.test(c.descriptionFa || ''))
  );
}

function isValidAxmlMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return bytes[0] === 0x03 && bytes[1] === 0x00 && bytes[2] === 0x08 && bytes[3] === 0x00;
}

async function neutralizeAdsInDex(data: Uint8Array): Promise<{ data: Uint8Array; hits: number }> {
  let buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  let hits = 0;
  for (const [from, to] of SAFE_AD_HOST_REPLACEMENTS) {
    if (from.length !== to.length) continue;
    const result = await patchDexString(buf, from, to);
    if (result.replacedCount > 0) {
      hits += result.replacedCount;
      buf = result.patchedBuffer;
    }
  }
  return { data: new Uint8Array(buf), hits };
}

/**
 * Rebuild APK:
 * - copy original binaries, strip META-INF signatures
 * - if chat/UI staged manifest changes → write Binary AXML from rawXmlText
 * - optional same-length DEX ad-host neutralization
 * Native apksig is applied afterwards by Capacitor plugin.
 */
export async function buildAndSignApk(
  project: ApkProject,
  baseZip: JSZip | null,
  _modifiedFiles: Map<string, string>,
  _keystore?: KeystoreConfig,
  onProgress?: (percent: number, stepText: string) => void
): Promise<{ blob: Blob; fileName: string; signedSha256: string; appliedManifest: boolean; adHits: number }> {
  onProgress?.(5, 'بررسی APK اصلی...');

  if (!baseZip) {
    throw new Error(
      'فایل APK اصلی در حافظه نیست. اول یک APK واقعی وارد کنید (برنامه‌های نصب‌شده یا فایل). نمونه داخلی قابل نصب نیست.'
    );
  }

  const zip = new JSZip();
  let hasManifest = false;
  let hasDex = false;
  let copied = 0;
  let adHits = 0;
  let appliedManifest = false;
  const doAdStrip = wantsSafeAdStrip(project);
  const doManifestRewrite =
    hasManifestChanges(project) && !!(project.manifest?.rawXmlText || '').includes('<manifest');

  onProgress?.(15, 'کپی باینری فایل‌های اصلی...');

  for (const path of Object.keys(baseZip.files)) {
    const fileObj = baseZip.files[path];
    if (!fileObj || fileObj.dir) continue;

    const norm = path.replace(/\\/g, '/');
    const upper = norm.toUpperCase();

    if (upper.startsWith('META-INF/')) {
      if (
        upper.endsWith('.SF') ||
        upper.endsWith('.RSA') ||
        upper.endsWith('.DSA') ||
        upper.endsWith('.EC') ||
        upper.endsWith('.MF') ||
        upper.includes('SIG-') ||
        upper.endsWith('MANIFEST.MF')
      ) {
        continue;
      }
    }

    const base = norm.split('/').pop() || norm;
    if (doManifestRewrite && (base === 'AndroidManifest.xml' || norm === 'AndroidManifest.xml')) {
      continue;
    }

    let data = await fileObj.async('uint8array');

    if (doAdStrip && base.endsWith('.dex')) {
      onProgress?.(40, `خنثی‌سازی امن host تبلیغات در ${base}...`);
      const result = await neutralizeAdsInDex(data);
      data = result.data;
      adHits += result.hits;
    }

    zip.file(path, data, { binary: true, date: fileObj.date || new Date(), compression: 'DEFLATE' });
    copied++;
    if (base === 'AndroidManifest.xml') hasManifest = true;
    if (base.endsWith('.dex')) hasDex = true;
  }

  if (doManifestRewrite) {
    onProgress?.(55, 'بازنویسی Binary AXML از منیفست اصلاح‌شده...');
    const xml = project.manifest.rawXmlText;
    let axml: Uint8Array;
    try {
      axml = encodeAxml(xml);
    } catch (e) {
      throw new Error(
        'خطا در تبدیل منیفست به Binary AXML: ' +
          (e instanceof Error ? e.message : String(e))
      );
    }

    if (!isValidAxmlMagic(axml)) {
      throw new Error(
        'منیفست به Binary AXML معتبر تبدیل نشد. تغییرات را ساده‌تر کنید یا فقط hardening/حذف تبلیغ را امتحان کنید.'
      );
    }

    zip.file('AndroidManifest.xml', axml, {
      binary: true,
      compression: 'DEFLATE',
      date: new Date(),
    });
    hasManifest = true;
    appliedManifest = true;
    copied++;
  }

  if (!hasManifest) throw new Error('AndroidManifest.xml در APK اصلی پیدا نشد');
  if (!hasDex) throw new Error('classes.dex در APK نیست');
  if (copied < 3) throw new Error('تعداد فایل‌های کپی‌شده غیرعادی کم است');

  onProgress?.(
    75,
    appliedManifest
      ? `منیفست باینری بازنویسی شد · ${copied} فایل · تبلیغ DEX: ${adHits}`
      : doAdStrip
        ? `بسته‌بندی ${copied} فایل · ${adHits} جایگزینی تبلیغ در DEX`
        : `بسته‌بندی ${copied} فایل (منیفست دست‌نخورده)`
  );

  const arrayBuffer = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const head = new Uint8Array(arrayBuffer, 0, 4);
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    throw new Error('خروجی ZIP نامعتبر است');
  }

  const apkBlob = new Blob([arrayBuffer], {
    type: 'application/vnd.android.package-archive',
  });

  const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const signedSha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const safeName = (project.name || 'app').replace(/[^a-zA-Z0-9_\-]/g, '_');
  const ver = project.manifest?.versionName || '1.0';
  const tags: string[] = [];
  if (appliedManifest) tags.push('patched');
  if (doAdStrip && adHits > 0) tags.push('adstrip');
  if (tags.length === 0) tags.push('resigned');
  const outFileName = `${safeName}_${tags.join('_')}_v${ver}.apk`;

  onProgress?.(100, 'بسته آماده — امضای Google apksig');

  return { blob: apkBlob, fileName: outFileName, signedSha256, appliedManifest, adHits };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}
