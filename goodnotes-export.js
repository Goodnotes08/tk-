/* Export als echte GoodNotes-Tinte (.goodnotes).
   Das Format ist nicht offiziell dokumentiert und wurde aus einer exportierten Datei nachgebaut.
   Aufbau: ZIP mit Protobuf-Dateien; jeder Strich ist ein Datensatz in notes/<seite>,
   seine Punkte stecken als Apple-LZ4-Block ("bv41") in einem "tpl"-Binärformat. */

const GN = (() => {
  const enc = new TextEncoder();

  const b64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

  const concat = parts => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  /* ---------- Protobuf ---------- */
  const varint = n => {
    const out = [];
    while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
    out.push(n);
    return Uint8Array.from(out);
  };
  const fv = (f, n) => concat([varint(f * 8), varint(n)]);
  const fb = (f, bytes) => concat([varint(f * 8 + 2), varint(bytes.length), bytes]);
  const ff = (f, x) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    return concat([varint(f * 8 + 5), b]);
  };
  const delim = m => concat([varint(m.length), m]);

  /* ---------- Binärschreiber ---------- */
  class Writer {
    constructor() { this.parts = []; }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); }
    f32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.parts.push(b); }
    bytes(b) { this.parts.push(b); }
    done() { return concat(this.parts); }
  }

  /* Apple-Kompressionsrahmen mit einem LZ4-Block, der nur Literale enthält (gültiges LZ4) */
  function bv41(raw) {
    const n = raw.length;
    const head = [];
    if (n < 15) head.push(n << 4);
    else {
      head.push(0xF0);
      let rest = n - 15;
      while (rest >= 255) { head.push(255); rest -= 255; }
      head.push(rest);
    }
    const block = concat([Uint8Array.from(head), raw]);
    const w = new Writer();
    w.bytes(enc.encode("bv41")); w.u32(n); w.u32(block.length); w.bytes(block); w.bytes(enc.encode("bv4$"));
    return w.done();
  }

  const SIGNATURE = enc.encode("vuA(v)A(S(uu))A(S(uuuu))vA(f)\0");

  /* Strich als Folge quadratischer Kurvenstücke: Kontrollpunkt = Messpunkt, Ende = Mitte zum nächsten */
  function strokePayload(points, width) {
    const segments = [];
    for (let i = 1; i < points.length - 1; i++) {
      const [cx, cy] = points[i], [nx, ny] = points[i + 1];
      segments.push([cx, cy, (cx + nx) / 2, (cy + ny) / 2]);
    }
    const [lx, ly] = points[points.length - 1];
    segments.push([lx, ly, lx, ly]);

    const w = new Writer();
    w.u16(2); w.f32(width);
    w.u32(segments.length + 1); w.u16(0); segments.forEach(() => w.u16(1));
    w.u32(1); w.f32(points[0][0]); w.f32(points[0][1]);
    w.u32(segments.length); segments.forEach(s => s.forEach(v => w.f32(v)));
    w.u16(1); w.u32(0);
    const body = concat([SIGNATURE, w.done()]);

    const out = new Writer();
    out.bytes(enc.encode("tpl\0")); out.u32(8 + body.length); out.bytes(body);
    return out.done();
  }

  const random32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const newId = () => enc.encode(crypto.randomUUID().toUpperCase());

  function hexToRgba(hex) {
    const v = parseInt(hex.replace("#", ""), 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255, 1];
  }

  function buildNotes(strokes, scaleX, scaleY, strokeConst) {
    const records = [];

    strokes.forEach((stroke, index) => {
      const points = [];
      for (const [x, y] of stroke.points) {
        const p = [x * scaleX, y * scaleY];
        const last = points[points.length - 1];
        if (!last || Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) > 0.05) points.push(p);
      }
      if (!points.length) return;
      if (points.length === 1) points.push([points[0][0] + 0.3, points[0][1] + 0.3]);

      const id = newId();
      const version = concat([fv(1, 2), fv(2, random32())]);
      const header = concat([
        fb(1, id), fb(2, version), strokeConst,
        fv(9, 4285000 + index), fv(14, 5381), fv(16, 24)
      ]);
      const color = concat(hexToRgba(stroke.color).map((c, i) => ff(i + 1, c)));
      const order = fb(1, concat([fv(1, index + 1), fv(2, random32())]));
      const body = concat([
        fb(1, id),
        fb(2, bv41(strokePayload(points, stroke.width * scaleX))),
        fb(4, color), fb(6, new Uint8Array(0)), fb(7, order), fb(9, new Uint8Array(0)),
        fb(15, version), fb(20, new Uint8Array(0)), fv(21, 24)
      ]);

      records.push(delim(header), delim(fb(7, body)));
    });

    return concat(records);
  }

  /* Alle IDs neu: nur der erste Block wird per XOR verändert,
     damit abgeleitete IDs (Seite …BB -> Notizen …BC) zusammenpassen */
  function idRemapper(keep) {
    const xor = random32() | 1;
    const pattern = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
    const map = text => text.replace(pattern, id =>
      keep.includes(id) ? id
        : ((parseInt(id.slice(0, 8), 16) ^ xor) >>> 0).toString(16).toUpperCase().padStart(8, "0") + id.slice(8));
    const bytes = data => {
      let s = "";
      for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      const out = map(s);
      return Uint8Array.from(out, c => c.charCodeAt(0));
    };
    return { text: map, bytes };
  }

  /* ---------- ZIP ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(data) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      return null;
    }
  }

  async function zip(entries) {
    const local = [], central = [];
    let offset = 0;

    for (const { name, data } of entries) {
      const nameBytes = enc.encode(name);
      const compressed = await deflateRaw(data);
      const method = compressed ? 8 : 0;
      const payload = compressed || data;
      const crc = crc32(data);

      const h = new Writer();
      h.u32(0x04034b50); h.u16(20); h.u16(0); h.u16(method); h.u16(0); h.u16(0x21);
      h.u32(crc); h.u32(payload.length); h.u32(data.length); h.u16(nameBytes.length); h.u16(0);
      h.bytes(nameBytes);
      const header = h.done();
      local.push(header, payload);

      const c = new Writer();
      c.u32(0x02014b50); c.u16(20); c.u16(20); c.u16(0); c.u16(method); c.u16(0); c.u16(0x21);
      c.u32(crc); c.u32(payload.length); c.u32(data.length); c.u16(nameBytes.length);
      c.u16(0); c.u16(0); c.u16(0); c.u16(0); c.u32(0); c.u32(offset);
      c.bytes(nameBytes);
      central.push(c.done());

      offset += header.length + payload.length;
    }

    const centralBytes = concat(central);
    const e = new Writer();
    e.u32(0x06054b50); e.u16(0); e.u16(0); e.u16(entries.length); e.u16(entries.length);
    e.u32(centralBytes.length); e.u32(offset); e.u16(0);
    return concat([...local, centralBytes, e.done()]);
  }

  /* ---------- Ganze Datei ---------- */
  async function buildDocument({ strokes, pageWidth, pageHeight, title, thumbnail }) {
    const T = GOODNOTES_TEMPLATE;
    const files = {};
    for (const name of T.order) files[name] = b64(T.files[name]);

    files[T.notes] = buildNotes(strokes, T.pageWidth / pageWidth, T.pageHeight / pageHeight, b64(T.strokeConst));
    files[T.thumbnail] = thumbnail;

    const titleField = fb(2, concat([fb(1, enc.encode(title)), fb(2, b64(T.titleVersion))]));
    const inner = concat([b64(T.docInnerHead), titleField, b64(T.docInnerTail)]);
    const docEvent = concat([fb(1, enc.encode(T.docId)), fb(30, inner)]);
    files[T.events] = concat([delim(docEvent), b64(T.restEvents)]);

    const remap = idRemapper(T.keepIds);
    const entries = T.order.map(name => ({ name: remap.text(name), data: remap.bytes(files[name]) }));
    return new Blob([await zip(entries)], { type: "application/octet-stream" });
  }

  return { buildDocument };
})();
