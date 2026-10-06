/**
 * Android Binary XML (AXML) Serializer.
 * NOTE: Full re-encode is lossy vs original resource IDs. Prefer preserving
 * original APK Binary AXML and in-place patching (see apkSigner.ts).
 * This encoder MUST NOT return plain-text XML bytes.
 */

const CHUNK_AXML_FILE = 0x00080003;
const CHUNK_STRING_POOL = 0x001c0001;
const CHUNK_START_NAMESPACE = 0x00100100;
const CHUNK_END_NAMESPACE = 0x00100101;
const CHUNK_START_TAG = 0x00100102;
const CHUNK_END_TAG = 0x00100103;

interface XmlNode {
  name: string;
  attributes: { prefix?: string; name: string; value: string }[];
  children: XmlNode[];
}

function parseSimpleXml(xmlText: string): XmlNode | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const rootEl = doc.documentElement;
    if (!rootEl) return null;

    function elToNode(el: Element): XmlNode {
      const attributes: XmlNode['attributes'] = [];
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        let name = attr.name;
        let prefix: string | undefined;
        if (name.includes(':')) {
          const parts = name.split(':');
          prefix = parts[0];
          name = parts[1];
        }
        attributes.push({ prefix, name, value: attr.value });
      }
      const children: XmlNode[] = [];
      for (let i = 0; i < el.children.length; i++) {
        children.push(elToNode(el.children[i]));
      }
      return { name: el.tagName, attributes, children };
    }
    return elToNode(rootEl);
  } catch {
    return null;
  }
}

/**
 * Encode XML string to Binary AXML. Throws if XML cannot be parsed.
 * Never returns UTF-8 text masquerading as AXML.
 */
export function encodeAxml(xmlText: string): Uint8Array {
  const root = parseSimpleXml(xmlText);
  if (!root) {
    throw new Error(
      'Manifest XML قابل parse نیست — Binary AXML ساخته نشد (متن خام داخل APK قرار نمی‌گیرد).'
    );
  }

  const stringPoolList: string[] = [];
  const stringMap = new Map<string, number>();

  function addString(s: string): number {
    if (stringMap.has(s)) return stringMap.get(s)!;
    const idx = stringPoolList.length;
    stringPoolList.push(s);
    stringMap.set(s, idx);
    return idx;
  }

  const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
  addString(ANDROID_NS);
  addString('android');

  function collectStrings(node: XmlNode) {
    addString(node.name);
    for (const attr of node.attributes) {
      addString(attr.name);
      addString(attr.value);
    }
    for (const child of node.children) collectStrings(child);
  }
  collectStrings(root);

  const stringOffsets: number[] = [];
  const encodedStrings: number[] = [];
  let currentStringByteOffset = 0;
  for (const str of stringPoolList) {
    stringOffsets.push(currentStringByteOffset);
    encodedStrings.push(str.length & 0xff, (str.length >> 8) & 0xff);
    currentStringByteOffset += 2;
    for (let c = 0; c < str.length; c++) {
      const code = str.charCodeAt(c);
      encodedStrings.push(code & 0xff, (code >> 8) & 0xff);
      currentStringByteOffset += 2;
    }
    encodedStrings.push(0x00, 0x00);
    currentStringByteOffset += 2;
  }
  while (encodedStrings.length % 4 !== 0) encodedStrings.push(0);

  const stringCount = stringPoolList.length;
  const headerSize = 28;
  const stringsStart = headerSize + stringCount * 4;
  const poolChunkSize = stringsStart + encodedStrings.length;
  const poolBuffer = new Uint8Array(poolChunkSize);
  const poolDv = new DataView(poolBuffer.buffer);
  poolDv.setUint32(0, CHUNK_STRING_POOL, true);
  poolDv.setUint32(4, poolChunkSize, true);
  poolDv.setUint32(8, stringCount, true);
  poolDv.setUint32(12, 0, true);
  poolDv.setUint32(16, 0, true);
  poolDv.setUint32(20, stringsStart, true);
  poolDv.setUint32(24, 0, true);
  for (let i = 0; i < stringCount; i++) {
    poolDv.setUint32(headerSize + i * 4, stringOffsets[i], true);
  }
  poolBuffer.set(encodedStrings, stringsStart);

  const bodyChunks: Uint8Array[] = [];
  const nsStartBuf = new Uint8Array(24);
  const nsStartDv = new DataView(nsStartBuf.buffer);
  nsStartDv.setUint32(0, CHUNK_START_NAMESPACE, true);
  nsStartDv.setUint32(4, 24, true);
  nsStartDv.setUint32(8, 1, true);
  nsStartDv.setUint32(12, 0xffffffff, true);
  nsStartDv.setUint32(16, addString('android'), true);
  nsStartDv.setUint32(20, addString(ANDROID_NS), true);
  bodyChunks.push(nsStartBuf);

  function writeNode(node: XmlNode, line: number) {
    const attrCount = node.attributes.length;
    const tagSize = 36 + attrCount * 20;
    const tagBuf = new Uint8Array(tagSize);
    const tagDv = new DataView(tagBuf.buffer);
    tagDv.setUint32(0, CHUNK_START_TAG, true);
    tagDv.setUint32(4, tagSize, true);
    tagDv.setUint32(8, line, true);
    tagDv.setUint32(12, 0xffffffff, true);
    tagDv.setUint32(16, 0xffffffff, true);
    tagDv.setUint32(20, addString(node.name), true);
    tagDv.setUint16(24, 20, true);
    tagDv.setUint16(26, 20, true);
    tagDv.setUint16(28, attrCount, true);
    tagDv.setUint16(30, 0, true);
    tagDv.setUint16(32, 0, true);
    tagDv.setUint16(34, 0, true);

    let attrOffset = 36;
    for (const attr of node.attributes) {
      const isAndroid = attr.prefix === 'android';
      tagDv.setUint32(attrOffset, isAndroid ? addString(ANDROID_NS) : 0xffffffff, true);
      tagDv.setUint32(attrOffset + 4, addString(attr.name), true);
      tagDv.setUint32(attrOffset + 8, addString(attr.value), true);
      if (attr.value === 'true' || attr.value === 'false') {
        tagDv.setUint32(attrOffset + 12, (0x12 << 24) | 0x08, true);
        tagDv.setUint32(attrOffset + 16, attr.value === 'true' ? 0xffffffff : 0, true);
      } else if (!isNaN(Number(attr.value)) && !attr.value.includes('.')) {
        tagDv.setUint32(attrOffset + 12, (0x10 << 24) | 0x08, true);
        tagDv.setUint32(attrOffset + 16, parseInt(attr.value, 10), true);
      } else if (/^@/.test(attr.value)) {
        // TYPE_REFERENCE — keep as string value in pool (lossy vs real resource id)
        tagDv.setUint32(attrOffset + 12, (0x03 << 24) | 0x08, true);
        tagDv.setUint32(attrOffset + 16, addString(attr.value), true);
      } else {
        tagDv.setUint32(attrOffset + 12, (0x03 << 24) | 0x08, true);
        tagDv.setUint32(attrOffset + 16, addString(attr.value), true);
      }
      attrOffset += 20;
    }
    bodyChunks.push(tagBuf);
    for (let c = 0; c < node.children.length; c++) writeNode(node.children[c], line + c + 1);
    const endBuf = new Uint8Array(24);
    const endDv = new DataView(endBuf.buffer);
    endDv.setUint32(0, CHUNK_END_TAG, true);
    endDv.setUint32(4, 24, true);
    endDv.setUint32(8, line, true);
    endDv.setUint32(12, 0xffffffff, true);
    endDv.setUint32(16, 0xffffffff, true);
    endDv.setUint32(20, addString(node.name), true);
    bodyChunks.push(endBuf);
  }

  writeNode(root, 1);

  const nsEndBuf = new Uint8Array(24);
  const nsEndDv = new DataView(nsEndBuf.buffer);
  nsEndDv.setUint32(0, CHUNK_END_NAMESPACE, true);
  nsEndDv.setUint32(4, 24, true);
  nsEndDv.setUint32(8, 100, true);
  nsEndDv.setUint32(12, 0xffffffff, true);
  nsEndDv.setUint32(16, addString('android'), true);
  nsEndDv.setUint32(20, addString(ANDROID_NS), true);
  bodyChunks.push(nsEndBuf);

  const totalBodyBytes = bodyChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const totalFileSize = 8 + poolBuffer.byteLength + totalBodyBytes;
  const result = new Uint8Array(totalFileSize);
  const resultDv = new DataView(result.buffer);
  resultDv.setUint32(0, CHUNK_AXML_FILE, true);
  resultDv.setUint32(4, totalFileSize, true);
  result.set(poolBuffer, 8);
  let pos = 8 + poolBuffer.byteLength;
  for (const chunk of bodyChunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result;
}
