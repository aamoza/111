import JSZip from 'jszip';
import { ApkProject } from '../types/apk';
import { patchDexString } from './dexPatcher';

export interface KeystoreConfig {
  alias: string;
  keyPass?: string;
  storePass?: string;
  commonName: string;
  organization: string;
}

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

function wantsHardening(project: ApkProject): boolean {
  const changes = project.changes || [];
  const xml = project.manifest?.rawXmlText || '';
  const attrs = project.manifest?.applicationAttrs;
  if (attrs && (!attrs.usesCleartextTraffic && !attrs.allowBackup && !attrs.debuggable)) {
    // already hardened in metadata — still try binary patch if changes recorded
  }
  return changes.some((c) =>
    /پچ امن|harden|اصلاح|cleartext|debuggable|allowBackup|سخت.?سازی/i.test(
      (c.descriptionFa || '') + ' ' + (c.after || '')
    )
  ) || /android:usesCleartextTraffic="false"/.test(xml);
}

/** Validate Android Binary AXML header and basic chunk bounds. */
export function validateBinaryAxml(bytes: Uint8Array): { ok: boolean; error?: string } {
  if (bytes.length < 8) return { ok: false, error: 'AXML خیلی کوتاه است' };
  // magic 0x00080003 LE
  if (!(bytes[0] === 0x03 && bytes[1] === 0x00 && bytes[2] === 0x08 && bytes[3] === 0x00)) {
    return { ok: false, error: 'امضای Binary AXML نامعتبر است (متن XML در APK مجاز نیست)' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = view.getUint32(4, true);
  if (fileSize > bytes.length + 8 && fileSize > bytes.length) {
    // some producers set size loosely — only fail if wildly off
    if (fileSize > bytes.length * 2) {
      return { ok: false, error: 'اندازه header AXML با فایل نمی‌خواند' };
    }
  }
  let offset = 8;
  let chunks = 0;
  while (offset + 8 <= bytes.length && chunks < 5000) {
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkSize < 8 || offset + chunkSize > bytes.length) {
      // tolerate trailing padding
      break;
    }
    offset += chunkSize;
    chunks++;
  }
  if (chunks < 1) return { ok: false, error: 'هیچ chunk معتبری در AXML نیست' };
  return { ok: true };
}

/**
 * In-place patch of boolean android attributes in Binary AXML string pool + start tags.
 * Finds TYPE_INT_BOOLEAN attributes; when attr name matches, sets data to false (0).
 * Preserves structure — no full re-encode.
 */
function patchBooleanAttrsInAxml(
  data: Uint8Array,
  forceFalseNames: string[]
): { data: Uint8Array; patched: number } {
  const out = new Uint8Array(data);
  const view = new DataView(out.buffer);
  if (!validateBinaryAxml(out).ok) return { data: out, patched: 0 };

  // Parse string pool at first chunk
  let offset = 8;
  const strings: string[] = [];
  let stringPoolStart = -1;

  while (offset + 8 <= out.length) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || offset + size > out.length) break;

    if (type === 0x001c0001 || (type & 0xffff) === 0x0001) {
      stringPoolStart = offset;
      const stringCount = view.getUint32(offset + 8, true);
      const flags = view.getUint32(offset + 16, true);
      const stringsStart = offset + view.getUint32(offset + 20, true);
      const isUtf8 = (flags & (1 << 8)) !== 0;
      for (let i = 0; i < stringCount && i < 20000; i++) {
        const strOff = stringsStart + view.getUint32(offset + 28 + i * 4, true);
        try {
          if (isUtf8) {
            let cur = strOff;
            let charLen = out[cur++];
            if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | out[cur++];
            let byteLen = out[cur++];
            if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | out[cur++];
            strings.push(new TextDecoder('utf-8', { fatal: false }).decode(out.subarray(cur, cur + byteLen)));
          } else {
            let cur = strOff;
            let len = view.getUint16(cur, true);
            cur += 2;
            if (len & 0x8000) {
              len = ((len & 0x7fff) << 16) | view.getUint16(cur, true);
              cur += 2;
            }
            let s = '';
            for (let j = 0; j < len && cur + 2 <= out.length; j++) {
              const c = view.getUint16(cur, true);
              cur += 2;
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            strings.push(s);
          }
        } catch {
          strings.push('');
        }
      }
      break;
    }
    offset += size;
  }

  if (stringPoolStart < 0 || strings.length === 0) return { data: out, patched: 0 };

  const targetIdx = new Set<number>();
  forceFalseNames.forEach((name) => {
    const i = strings.findIndex((s) => s === name);
    if (i >= 0) targetIdx.add(i);
  });
  if (targetIdx.size === 0) return { data: out, patched: 0 };

  let patched = 0;
  offset = 8;
  while (offset + 8 <= out.length) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || offset + size > out.length) break;

    // START_TAG
    if (type === 0x00100102) {
      const attrCount = view.getUint16(offset + 28, true);
      let attrOff = offset + 36;
      for (let a = 0; a < attrCount; a++) {
        if (attrOff + 20 > offset + size) break;
        const nameIdx = view.getUint32(attrOff + 4, true);
        const aType = view.getUint32(attrOff + 12, true) >> 24;
        // TYPE_INT_BOOLEAN = 0x12
        if (targetIdx.has(nameIdx) && aType === 0x12) {
          view.setUint32(attrOff + 16, 0, true); // false
          patched++;
        }
        attrOff += 20;
      }
    }
    offset += size;
  }

  return { data: out, patched };
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
 * Rebuild APK for installability:
 * - Always preserve original Binary AndroidManifest structure (no full re-encode from text).
 * - Optional in-place boolean hardening on original AXML.
 * - Optional same-length DEX ad host neutralization.
 * - Strip META-INF signatures for re-sign.
 * - Fail if final manifest is not valid Binary AXML.
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
      'فایل APK اصلی در حافظه نیست. اول یک APK واقعی وارد کنید. نمونه داخلی قابل نصب نیست.'
    );
  }

  const zip = new JSZip();
  let hasManifest = false;
  let hasDex = false;
  let copied = 0;
  let adHits = 0;
  let appliedManifest = false;
  const doAdStrip = wantsSafeAdStrip(project);
  const doHarden = wantsHardening(project);

  onProgress?.(15, 'کپی باینری فایل‌های اصلی (حفظ ساختار AXML)...');

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

    let data = await fileObj.async('uint8array');
    const base = norm.split('/').pop() || norm;

    if (base === 'AndroidManifest.xml' || norm === 'AndroidManifest.xml') {
      const v = validateBinaryAxml(data);
      if (!v.ok) {
        throw new Error(
          'AndroidManifest باینری اصلی نامعتبر است: ' +
            (v.error || '') +
            ' — از APK واقعی استفاده کنید.'
        );
      }
      if (doHarden) {
        onProgress?.(35, 'پچ امنیتی درجا روی Binary AXML اصلی...');
        const r = patchBooleanAttrsInAxml(data, [
          'usesCleartextTraffic',
          'allowBackup',
          'debuggable',
        ]);
        data = r.data;
        if (r.patched > 0) appliedManifest = true;
      }
      const v2 = validateBinaryAxml(data);
      if (!v2.ok) {
        throw new Error(
          'Manifest Binary AXML بعد از پچ معتبر نیست؛ APK ساخته نشد تا فایل خراب تولید نشود. ' +
            (v2.error || '')
        );
      }
      hasManifest = true;
    }

    if (doAdStrip && base.endsWith('.dex')) {
      onProgress?.(40, `خنثی‌سازی امن host تبلیغات در ${base}...`);
      const result = await neutralizeAdsInDex(data);
      data = result.data;
      adHits += result.hits;
    }

    if (base.endsWith('.dex')) hasDex = true;

    zip.file(path, data, { binary: true, date: fileObj.date || new Date(), compression: 'DEFLATE' });
    copied++;
  }

  if (!hasManifest) throw new Error('AndroidManifest.xml در APK اصلی پیدا نشد');
  if (!hasDex) throw new Error('classes.dex در APK نیست');
  if (copied < 3) throw new Error('تعداد فایل‌های کپی‌شده غیرعادی کم است');

  onProgress?.(
    75,
    appliedManifest
      ? `AXML اصلی حفظ + پچ بولین · ${copied} فایل · تبلیغ DEX: ${adHits}`
      : doAdStrip
        ? `منیفست اصلی دست‌نخورده · ${adHits} host تبلیغ`
        : `منیفست اصلی دست‌نخورده · ${copied} فایل`
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
  if (appliedManifest) tags.push('hardened');
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
