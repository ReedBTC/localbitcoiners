var Ke = Object.defineProperty;
var Me = (e, t, r) => t in e ? Ke(e, t, { enumerable: !0, configurable: !0, writable: !0, value: r }) : e[t] = r;
var y = (e, t, r) => Me(e, typeof t != "symbol" ? t + "" : t, r);
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function Pe(e) {
  return e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array";
}
function zt(e, t = "") {
  if (!Number.isSafeInteger(e) || e < 0) {
    const r = t && `"${t}" `;
    throw new Error(`${r}expected integer >= 0, got ${e}`);
  }
}
function Z(e, t, r = "") {
  const n = Pe(e), o = e == null ? void 0 : e.length, i = t !== void 0;
  if (!n || i && o !== t) {
    const s = r && `"${r}" `, c = i ? ` of length ${t}` : "", f = n ? `length=${o}` : `type=${typeof e}`;
    throw new Error(s + "expected Uint8Array" + c + ", got " + f);
  }
  return e;
}
function te(e, t = !0) {
  if (e.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (t && e.finished)
    throw new Error("Hash#digest() has already been called");
}
function Ge(e, t) {
  Z(e, void 0, "digestInto() output");
  const r = t.outputLen;
  if (e.length < r)
    throw new Error('"digestInto() output" expected to be of length >=' + r);
}
function Ut(...e) {
  for (let t = 0; t < e.length; t++)
    e[t].fill(0);
}
function $t(e) {
  return new DataView(e.buffer, e.byteOffset, e.byteLength);
}
function K(e, t) {
  return e << 32 - t | e >>> t;
}
const be = /* @ts-ignore */ typeof Uint8Array.from([]).toHex == "function" && typeof Uint8Array.fromHex == "function", Xe = /* @__PURE__ */ Array.from({ length: 256 }, (e, t) => t.toString(16).padStart(2, "0"));
function T(e) {
  if (Z(e), be)
    return e.toHex();
  let t = "";
  for (let r = 0; r < e.length; r++)
    t += Xe[e[r]];
  return t;
}
const M = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function ee(e) {
  if (e >= M._0 && e <= M._9)
    return e - M._0;
  if (e >= M.A && e <= M.F)
    return e - (M.A - 10);
  if (e >= M.a && e <= M.f)
    return e - (M.a - 10);
}
function C(e) {
  if (typeof e != "string")
    throw new Error("hex string expected, got " + typeof e);
  if (be)
    return Uint8Array.fromHex(e);
  const t = e.length, r = t / 2;
  if (t % 2)
    throw new Error("hex string expected, got unpadded hex of length " + t);
  const n = new Uint8Array(r);
  for (let o = 0, i = 0; o < r; o++, i += 2) {
    const s = ee(e.charCodeAt(i)), c = ee(e.charCodeAt(i + 1));
    if (s === void 0 || c === void 0) {
      const f = e[i] + e[i + 1];
      throw new Error('hex string expected, got non-hex character "' + f + '" at index ' + i);
    }
    n[o] = s * 16 + c;
  }
  return n;
}
function at(...e) {
  let t = 0;
  for (let n = 0; n < e.length; n++) {
    const o = e[n];
    Z(o), t += o.length;
  }
  const r = new Uint8Array(t);
  for (let n = 0, o = 0; n < e.length; n++) {
    const i = e[n];
    r.set(i, o), o += i.length;
  }
  return r;
}
function We(e, t = {}) {
  const r = (o, i) => e(i).update(o).digest(), n = e(void 0);
  return r.outputLen = n.outputLen, r.blockLen = n.blockLen, r.create = (o) => e(o), Object.assign(r, t), Object.freeze(r);
}
function ye(e = 32) {
  const t = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (t == null ? void 0 : t.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return t.getRandomValues(new Uint8Array(e));
}
const Fe = (e) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, e])
});
function Je(e, t, r) {
  return e & t ^ ~e & r;
}
function Qe(e, t, r) {
  return e & t ^ e & r ^ t & r;
}
class tn {
  constructor(t, r, n, o) {
    y(this, "blockLen");
    y(this, "outputLen");
    y(this, "padOffset");
    y(this, "isLE");
    // For partial updates less than block size
    y(this, "buffer");
    y(this, "view");
    y(this, "finished", !1);
    y(this, "length", 0);
    y(this, "pos", 0);
    y(this, "destroyed", !1);
    this.blockLen = t, this.outputLen = r, this.padOffset = n, this.isLE = o, this.buffer = new Uint8Array(t), this.view = $t(this.buffer);
  }
  update(t) {
    te(this), Z(t);
    const { view: r, buffer: n, blockLen: o } = this, i = t.length;
    for (let s = 0; s < i; ) {
      const c = Math.min(o - this.pos, i - s);
      if (c === o) {
        const f = $t(t);
        for (; o <= i - s; s += o)
          this.process(f, s);
        continue;
      }
      n.set(t.subarray(s, s + c), this.pos), this.pos += c, s += c, this.pos === o && (this.process(r, 0), this.pos = 0);
    }
    return this.length += t.length, this.roundClean(), this;
  }
  digestInto(t) {
    te(this), Ge(t, this), this.finished = !0;
    const { buffer: r, view: n, blockLen: o, isLE: i } = this;
    let { pos: s } = this;
    r[s++] = 128, Ut(this.buffer.subarray(s)), this.padOffset > o - s && (this.process(n, 0), s = 0);
    for (let a = s; a < o; a++)
      r[a] = 0;
    n.setBigUint64(o - 8, BigInt(this.length * 8), i), this.process(n, 0);
    const c = $t(t), f = this.outputLen;
    if (f % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const d = f / 4, l = this.get();
    if (d > l.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let a = 0; a < d; a++)
      c.setUint32(4 * a, l[a], i);
  }
  digest() {
    const { buffer: t, outputLen: r } = this;
    this.digestInto(t);
    const n = t.slice(0, r);
    return this.destroy(), n;
  }
  _cloneInto(t) {
    t || (t = new this.constructor()), t.set(...this.get());
    const { blockLen: r, buffer: n, length: o, finished: i, destroyed: s, pos: c } = this;
    return t.destroyed = s, t.finished = i, t.length = o, t.pos = c, o % r && t.buffer.set(n), t;
  }
  clone() {
    return this._cloneInto();
  }
}
const G = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), en = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), X = /* @__PURE__ */ new Uint32Array(64);
class nn extends tn {
  constructor(t) {
    super(64, t, 8, !1);
  }
  get() {
    const { A: t, B: r, C: n, D: o, E: i, F: s, G: c, H: f } = this;
    return [t, r, n, o, i, s, c, f];
  }
  // prettier-ignore
  set(t, r, n, o, i, s, c, f) {
    this.A = t | 0, this.B = r | 0, this.C = n | 0, this.D = o | 0, this.E = i | 0, this.F = s | 0, this.G = c | 0, this.H = f | 0;
  }
  process(t, r) {
    for (let a = 0; a < 16; a++, r += 4)
      X[a] = t.getUint32(r, !1);
    for (let a = 16; a < 64; a++) {
      const h = X[a - 15], g = X[a - 2], A = K(h, 7) ^ K(h, 18) ^ h >>> 3, I = K(g, 17) ^ K(g, 19) ^ g >>> 10;
      X[a] = I + X[a - 7] + A + X[a - 16] | 0;
    }
    let { A: n, B: o, C: i, D: s, E: c, F: f, G: d, H: l } = this;
    for (let a = 0; a < 64; a++) {
      const h = K(c, 6) ^ K(c, 11) ^ K(c, 25), g = l + h + Je(c, f, d) + en[a] + X[a] | 0, I = (K(n, 2) ^ K(n, 13) ^ K(n, 22)) + Qe(n, o, i) | 0;
      l = d, d = f, f = c, c = s + g | 0, s = i, i = o, o = n, n = g + I | 0;
    }
    n = n + this.A | 0, o = o + this.B | 0, i = i + this.C | 0, s = s + this.D | 0, c = c + this.E | 0, f = f + this.F | 0, d = d + this.G | 0, l = l + this.H | 0, this.set(n, o, i, s, c, f, d, l);
  }
  roundClean() {
    Ut(X);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), Ut(this.buffer);
  }
}
class rn extends nn {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    y(this, "A", G[0] | 0);
    y(this, "B", G[1] | 0);
    y(this, "C", G[2] | 0);
    y(this, "D", G[3] | 0);
    y(this, "E", G[4] | 0);
    y(this, "F", G[5] | 0);
    y(this, "G", G[6] | 0);
    y(this, "H", G[7] | 0);
  }
}
const Zt = /* @__PURE__ */ We(
  () => new rn(),
  /* @__PURE__ */ Fe(1)
);
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const jt = /* @__PURE__ */ BigInt(0), kt = /* @__PURE__ */ BigInt(1);
function ne(e, t = "") {
  if (typeof e != "boolean") {
    const r = t && `"${t}" `;
    throw new Error(r + "expected boolean, got type=" + typeof e);
  }
  return e;
}
function on(e) {
  if (typeof e == "bigint") {
    if (!fn(e))
      throw new Error("positive bigint expected, got " + e);
  } else
    zt(e);
  return e;
}
function Ee(e) {
  if (typeof e != "string")
    throw new Error("hex string expected, got " + typeof e);
  return e === "" ? jt : BigInt("0x" + e);
}
function Kt(e) {
  return Ee(T(e));
}
function pe(e) {
  return Ee(T(sn(Z(e)).reverse()));
}
function Mt(e, t) {
  zt(t), e = on(e);
  const r = C(e.toString(16).padStart(t * 2, "0"));
  if (r.length !== t)
    throw new Error("number too large");
  return r;
}
function me(e, t) {
  return Mt(e, t).reverse();
}
function sn(e) {
  return Uint8Array.from(e);
}
function cn(e) {
  return Uint8Array.from(e, (t, r) => {
    const n = t.charCodeAt(0);
    if (t.length !== 1 || n > 127)
      throw new Error(`string contains non-ASCII character "${e[r]}" with code ${n} at position ${r}`);
    return n;
  });
}
const fn = (e) => typeof e == "bigint" && jt <= e;
function an(e) {
  let t;
  for (t = 0; e > jt; e >>= kt, t += 1)
    ;
  return t;
}
const xe = (e) => (kt << BigInt(e)) - kt;
function Be(e, t = {}, r = {}) {
  if (!e || typeof e != "object")
    throw new Error("expected valid options object");
  function n(i, s, c) {
    const f = e[i];
    if (c && f === void 0)
      return;
    const d = typeof f;
    if (d !== s || f === null)
      throw new Error(`param "${i}" is invalid: expected ${s}, got ${d}`);
  }
  const o = (i, s) => Object.entries(i).forEach(([c, f]) => n(c, f, s));
  o(t, !1), o(r, !0);
}
function re(e) {
  const t = /* @__PURE__ */ new WeakMap();
  return (r, ...n) => {
    const o = t.get(r);
    if (o !== void 0)
      return o;
    const i = e(r, ...n);
    return t.set(r, i), i;
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const U = /* @__PURE__ */ BigInt(0), _ = /* @__PURE__ */ BigInt(1), F = /* @__PURE__ */ BigInt(2), ve = /* @__PURE__ */ BigInt(3), Ae = /* @__PURE__ */ BigInt(4), Re = /* @__PURE__ */ BigInt(5), un = /* @__PURE__ */ BigInt(7), Ie = /* @__PURE__ */ BigInt(8), dn = /* @__PURE__ */ BigInt(9), Oe = /* @__PURE__ */ BigInt(16);
function z(e, t) {
  const r = e % t;
  return r >= U ? r : t + r;
}
function D(e, t, r) {
  let n = e;
  for (; t-- > U; )
    n *= n, n %= r;
  return n;
}
function oe(e, t) {
  if (e === U)
    throw new Error("invert: expected non-zero number");
  if (t <= U)
    throw new Error("invert: expected positive modulus, got " + t);
  let r = z(e, t), n = t, o = U, i = _;
  for (; r !== U; ) {
    const c = n / r, f = n % r, d = o - i * c;
    n = r, r = f, o = i, i = d;
  }
  if (n !== _)
    throw new Error("invert: does not exist");
  return z(o, t);
}
function Pt(e, t, r) {
  if (!e.eql(e.sqr(t), r))
    throw new Error("Cannot find square root");
}
function Se(e, t) {
  const r = (e.ORDER + _) / Ae, n = e.pow(t, r);
  return Pt(e, n, t), n;
}
function ln(e, t) {
  const r = (e.ORDER - Re) / Ie, n = e.mul(t, F), o = e.pow(n, r), i = e.mul(t, o), s = e.mul(e.mul(i, F), o), c = e.mul(i, e.sub(s, e.ONE));
  return Pt(e, c, t), c;
}
function hn(e) {
  const t = At(e), r = $e(e), n = r(t, t.neg(t.ONE)), o = r(t, n), i = r(t, t.neg(n)), s = (e + un) / Oe;
  return (c, f) => {
    let d = c.pow(f, s), l = c.mul(d, n);
    const a = c.mul(d, o), h = c.mul(d, i), g = c.eql(c.sqr(l), f), A = c.eql(c.sqr(a), f);
    d = c.cmov(d, l, g), l = c.cmov(h, a, A);
    const I = c.eql(c.sqr(l), f), L = c.cmov(d, l, I);
    return Pt(c, L, f), L;
  };
}
function $e(e) {
  if (e < ve)
    throw new Error("sqrt is not defined for small field");
  let t = e - _, r = 0;
  for (; t % F === U; )
    t /= F, r++;
  let n = F;
  const o = At(e);
  for (; ie(o, n) === 1; )
    if (n++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  if (r === 1)
    return Se;
  let i = o.pow(n, t);
  const s = (t + _) / F;
  return function(f, d) {
    if (f.is0(d))
      return d;
    if (ie(f, d) !== 1)
      throw new Error("Cannot find square root");
    let l = r, a = f.mul(f.ONE, i), h = f.pow(d, t), g = f.pow(d, s);
    for (; !f.eql(h, f.ONE); ) {
      if (f.is0(h))
        return f.ZERO;
      let A = 1, I = f.sqr(h);
      for (; !f.eql(I, f.ONE); )
        if (A++, I = f.sqr(I), A === l)
          throw new Error("Cannot find square root");
      const L = _ << BigInt(l - A - 1), k = f.pow(a, L);
      l = A, a = f.sqr(k), h = f.mul(h, a), g = f.mul(g, k);
    }
    return g;
  };
}
function wn(e) {
  return e % Ae === ve ? Se : e % Ie === Re ? ln : e % Oe === dn ? hn(e) : $e(e);
}
const gn = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function bn(e) {
  const t = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  }, r = gn.reduce((n, o) => (n[o] = "function", n), t);
  return Be(e, r), e;
}
function yn(e, t, r) {
  if (r < U)
    throw new Error("invalid exponent, negatives unsupported");
  if (r === U)
    return e.ONE;
  if (r === _)
    return t;
  let n = e.ONE, o = t;
  for (; r > U; )
    r & _ && (n = e.mul(n, o)), o = e.sqr(o), r >>= _;
  return n;
}
function Ne(e, t, r = !1) {
  const n = new Array(t.length).fill(r ? e.ZERO : void 0), o = t.reduce((s, c, f) => e.is0(c) ? s : (n[f] = s, e.mul(s, c)), e.ONE), i = e.inv(o);
  return t.reduceRight((s, c, f) => e.is0(c) ? s : (n[f] = e.mul(s, n[f]), e.mul(s, c)), i), n;
}
function ie(e, t) {
  const r = (e.ORDER - _) / F, n = e.pow(t, r), o = e.eql(n, e.ONE), i = e.eql(n, e.ZERO), s = e.eql(n, e.neg(e.ONE));
  if (!o && !i && !s)
    throw new Error("invalid Legendre symbol result");
  return o ? 1 : i ? 0 : -1;
}
function En(e, t) {
  t !== void 0 && zt(t);
  const r = t !== void 0 ? t : e.toString(2).length, n = Math.ceil(r / 8);
  return { nBitLength: r, nByteLength: n };
}
class pn {
  constructor(t, r = {}) {
    y(this, "ORDER");
    y(this, "BITS");
    y(this, "BYTES");
    y(this, "isLE");
    y(this, "ZERO", U);
    y(this, "ONE", _);
    y(this, "_lengths");
    y(this, "_sqrt");
    // cached sqrt
    y(this, "_mod");
    var s;
    if (t <= U)
      throw new Error("invalid field: expected ORDER > 0, got " + t);
    let n;
    this.isLE = !1, r != null && typeof r == "object" && (typeof r.BITS == "number" && (n = r.BITS), typeof r.sqrt == "function" && (this.sqrt = r.sqrt), typeof r.isLE == "boolean" && (this.isLE = r.isLE), r.allowedLengths && (this._lengths = (s = r.allowedLengths) == null ? void 0 : s.slice()), typeof r.modFromBytes == "boolean" && (this._mod = r.modFromBytes));
    const { nBitLength: o, nByteLength: i } = En(t, n);
    if (i > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = t, this.BITS = o, this.BYTES = i, this._sqrt = void 0, Object.preventExtensions(this);
  }
  create(t) {
    return z(t, this.ORDER);
  }
  isValid(t) {
    if (typeof t != "bigint")
      throw new Error("invalid field element: expected bigint, got " + typeof t);
    return U <= t && t < this.ORDER;
  }
  is0(t) {
    return t === U;
  }
  // is valid and invertible
  isValidNot0(t) {
    return !this.is0(t) && this.isValid(t);
  }
  isOdd(t) {
    return (t & _) === _;
  }
  neg(t) {
    return z(-t, this.ORDER);
  }
  eql(t, r) {
    return t === r;
  }
  sqr(t) {
    return z(t * t, this.ORDER);
  }
  add(t, r) {
    return z(t + r, this.ORDER);
  }
  sub(t, r) {
    return z(t - r, this.ORDER);
  }
  mul(t, r) {
    return z(t * r, this.ORDER);
  }
  pow(t, r) {
    return yn(this, t, r);
  }
  div(t, r) {
    return z(t * oe(r, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(t) {
    return t * t;
  }
  addN(t, r) {
    return t + r;
  }
  subN(t, r) {
    return t - r;
  }
  mulN(t, r) {
    return t * r;
  }
  inv(t) {
    return oe(t, this.ORDER);
  }
  sqrt(t) {
    return this._sqrt || (this._sqrt = wn(this.ORDER)), this._sqrt(this, t);
  }
  toBytes(t) {
    return this.isLE ? me(t, this.BYTES) : Mt(t, this.BYTES);
  }
  fromBytes(t, r = !1) {
    Z(t);
    const { _lengths: n, BYTES: o, isLE: i, ORDER: s, _mod: c } = this;
    if (n) {
      if (!n.includes(t.length) || t.length > o)
        throw new Error("Field.fromBytes: expected " + n + " bytes, got " + t.length);
      const d = new Uint8Array(o);
      d.set(t, i ? 0 : d.length - t.length), t = d;
    }
    if (t.length !== o)
      throw new Error("Field.fromBytes: expected " + o + " bytes, got " + t.length);
    let f = i ? pe(t) : Kt(t);
    if (c && (f = z(f, s)), !r && !this.isValid(f))
      throw new Error("invalid field element: outside of range 0..ORDER");
    return f;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(t) {
    return Ne(this, t);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(t, r, n) {
    return n ? r : t;
  }
}
function At(e, t = {}) {
  return new pn(e, t);
}
function Le(e) {
  if (typeof e != "bigint")
    throw new Error("field order must be bigint");
  const t = e.toString(2).length;
  return Math.ceil(t / 8);
}
function mn(e) {
  const t = Le(e);
  return t + Math.ceil(t / 2);
}
function xn(e, t, r = !1) {
  Z(e);
  const n = e.length, o = Le(t), i = mn(t);
  if (n < 16 || n < i || n > 1024)
    throw new Error("expected " + i + "-1024 bytes of input, got " + n);
  const s = r ? pe(e) : Kt(e), c = z(s, t - _) + _;
  return r ? me(c, o) : Mt(c, o);
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const nt = /* @__PURE__ */ BigInt(0), J = /* @__PURE__ */ BigInt(1);
function Et(e, t) {
  const r = t.negate();
  return e ? r : t;
}
function se(e, t) {
  const r = Ne(e.Fp, t.map((n) => n.Z));
  return t.map((n, o) => e.fromAffine(n.toAffine(r[o])));
}
function qe(e, t) {
  if (!Number.isSafeInteger(e) || e <= 0 || e > t)
    throw new Error("invalid window size, expected [1.." + t + "], got W=" + e);
}
function Nt(e, t) {
  qe(e, t);
  const r = Math.ceil(t / e) + 1, n = 2 ** (e - 1), o = 2 ** e, i = xe(e), s = BigInt(e);
  return { windows: r, windowSize: n, mask: i, maxNumber: o, shiftBy: s };
}
function ce(e, t, r) {
  const { windowSize: n, mask: o, maxNumber: i, shiftBy: s } = r;
  let c = Number(e & o), f = e >> s;
  c > n && (c -= i, f += J);
  const d = t * n, l = d + Math.abs(c) - 1, a = c === 0, h = c < 0, g = t % 2 !== 0;
  return { nextN: f, offset: l, isZero: a, isNeg: h, isNegF: g, offsetF: d };
}
const Lt = /* @__PURE__ */ new WeakMap(), _e = /* @__PURE__ */ new WeakMap();
function qt(e) {
  return _e.get(e) || 1;
}
function fe(e) {
  if (e !== nt)
    throw new Error("invalid wNAF");
}
class Bn {
  // Parametrized with a given Point class (not individual point)
  constructor(t, r) {
    y(this, "BASE");
    y(this, "ZERO");
    y(this, "Fn");
    y(this, "bits");
    this.BASE = t.BASE, this.ZERO = t.ZERO, this.Fn = t.Fn, this.bits = r;
  }
  // non-const time multiplication ladder
  _unsafeLadder(t, r, n = this.ZERO) {
    let o = t;
    for (; r > nt; )
      r & J && (n = n.add(o)), o = o.double(), r >>= J;
    return n;
  }
  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Number of precomputed points depends on the curve size:
   * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
   * - 𝑊 is the window size
   * - 𝑛 is the bitlength of the curve order.
   * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
   * @param point Point instance
   * @param W window size
   * @returns precomputed point tables flattened to a single array
   */
  precomputeWindow(t, r) {
    const { windows: n, windowSize: o } = Nt(r, this.bits), i = [];
    let s = t, c = s;
    for (let f = 0; f < n; f++) {
      c = s, i.push(c);
      for (let d = 1; d < o; d++)
        c = c.add(s), i.push(c);
      s = c.double();
    }
    return i;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(t, r, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let o = this.ZERO, i = this.BASE;
    const s = Nt(t, this.bits);
    for (let c = 0; c < s.windows; c++) {
      const { nextN: f, offset: d, isZero: l, isNeg: a, isNegF: h, offsetF: g } = ce(n, c, s);
      n = f, l ? i = i.add(Et(h, r[g])) : o = o.add(Et(a, r[d]));
    }
    return fe(n), { p: o, f: i };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(t, r, n, o = this.ZERO) {
    const i = Nt(t, this.bits);
    for (let s = 0; s < i.windows && n !== nt; s++) {
      const { nextN: c, offset: f, isZero: d, isNeg: l } = ce(n, s, i);
      if (n = c, !d) {
        const a = r[f];
        o = o.add(l ? a.negate() : a);
      }
    }
    return fe(n), o;
  }
  getPrecomputes(t, r, n) {
    let o = Lt.get(r);
    return o || (o = this.precomputeWindow(r, t), t !== 1 && (typeof n == "function" && (o = n(o)), Lt.set(r, o))), o;
  }
  cached(t, r, n) {
    const o = qt(t);
    return this.wNAF(o, this.getPrecomputes(o, t, n), r);
  }
  unsafe(t, r, n, o) {
    const i = qt(t);
    return i === 1 ? this._unsafeLadder(t, r, o) : this.wNAFUnsafe(i, this.getPrecomputes(i, t, n), r, o);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(t, r) {
    qe(r, this.bits), _e.set(t, r), Lt.delete(t);
  }
  hasCache(t) {
    return qt(t) !== 1;
  }
}
function vn(e, t, r, n) {
  let o = t, i = e.ZERO, s = e.ZERO;
  for (; r > nt || n > nt; )
    r & J && (i = i.add(o)), n & J && (s = s.add(o)), o = o.double(), r >>= J, n >>= J;
  return { p1: i, p2: s };
}
function ae(e, t, r) {
  if (t) {
    if (t.ORDER !== e)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    return bn(t), t;
  } else
    return At(e, { isLE: r });
}
function An(e, t, r = {}, n) {
  if (n === void 0 && (n = e === "edwards"), !t || typeof t != "object")
    throw new Error(`expected valid ${e} CURVE object`);
  for (const f of ["p", "n", "h"]) {
    const d = t[f];
    if (!(typeof d == "bigint" && d > nt))
      throw new Error(`CURVE.${f} must be positive bigint`);
  }
  const o = ae(t.p, r.Fp, n), i = ae(t.n, r.Fn, n), c = ["Gx", "Gy", "a", "b"];
  for (const f of c)
    if (!o.isValid(t[f]))
      throw new Error(`CURVE.${f} must be valid field element of CURVE.Fp`);
  return t = Object.freeze(Object.assign({}, t)), { CURVE: t, Fp: o, Fn: i };
}
function Rn(e, t) {
  return function(n) {
    const o = e(n);
    return { secretKey: o, publicKey: t(o) };
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const ue = (e, t) => (e + (e >= 0 ? t : -t) / On) / t;
function In(e, t, r) {
  const [[n, o], [i, s]] = t, c = ue(s * e, r), f = ue(-o * e, r);
  let d = e - c * n - f * i, l = -c * o - f * s;
  const a = d < ct, h = l < ct;
  a && (d = -d), h && (l = -l);
  const g = xe(Math.ceil(an(r) / 2)) + bt;
  if (d < ct || d >= g || l < ct || l >= g)
    throw new Error("splitScalar (endomorphism): failed, k=" + e);
  return { k1neg: a, k1: d, k2neg: h, k2: l };
}
const ct = BigInt(0), bt = BigInt(1), On = BigInt(2), wt = BigInt(3), Sn = BigInt(4);
function $n(e, t = {}) {
  const r = An("weierstrass", e, t), { Fp: n, Fn: o } = r;
  let i = r.CURVE;
  const { h: s, n: c } = i;
  Be(t, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  const { endo: f } = t;
  if (f && (!n.is0(i.a) || typeof f.beta != "bigint" || !Array.isArray(f.basises)))
    throw new Error('invalid endo: expected "beta": bigint and "basises": array');
  const d = Ln(n, o);
  function l() {
    if (!n.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function a(R, u, w) {
    const { x: E, y: p } = u.toAffine(), O = n.toBytes(E);
    if (ne(w, "isCompressed"), w) {
      l();
      const B = !n.isOdd(p);
      return at(Nn(B), O);
    } else
      return at(Uint8Array.of(4), O, n.toBytes(p));
  }
  function h(R) {
    Z(R, void 0, "Point");
    const { publicKey: u, publicKeyUncompressed: w } = d, E = R.length, p = R[0], O = R.subarray(1);
    if (E === u && (p === 2 || p === 3)) {
      const B = n.fromBytes(O);
      if (!n.isValid(B))
        throw new Error("bad point: is not on curve, wrong x");
      const m = I(B);
      let b;
      try {
        b = n.sqrt(m);
      } catch (V) {
        const N = V instanceof Error ? ": " + V.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + N);
      }
      l();
      const x = n.isOdd(b);
      return (p & 1) === 1 !== x && (b = n.neg(b)), { x: B, y: b };
    } else if (E === w && p === 4) {
      const B = n.BYTES, m = n.fromBytes(O.subarray(0, B)), b = n.fromBytes(O.subarray(B, B * 2));
      if (!L(m, b))
        throw new Error("bad point: is not on curve");
      return { x: m, y: b };
    } else
      throw new Error(`bad point: got length ${E}, expected compressed=${u} or uncompressed=${w}`);
  }
  const g = t.toBytes || a, A = t.fromBytes || h;
  function I(R) {
    const u = n.sqr(R), w = n.mul(u, R);
    return n.add(n.add(w, n.mul(R, i.a)), i.b);
  }
  function L(R, u) {
    const w = n.sqr(u), E = I(R);
    return n.eql(w, E);
  }
  if (!L(i.Gx, i.Gy))
    throw new Error("bad curve params: generator point");
  const k = n.mul(n.pow(i.a, wt), Sn), Q = n.mul(n.sqr(i.b), BigInt(27));
  if (n.is0(n.add(k, Q)))
    throw new Error("bad curve params: a or b");
  function P(R, u, w = !1) {
    if (!n.isValid(u) || w && n.is0(u))
      throw new Error(`bad point coordinate ${R}`);
    return u;
  }
  function dt(R) {
    if (!(R instanceof W))
      throw new Error("Weierstrass Point expected");
  }
  function lt(R) {
    if (!f || !f.basises)
      throw new Error("no endo");
    return In(R, f.basises, o.ORDER);
  }
  const ht = re((R, u) => {
    const { X: w, Y: E, Z: p } = R;
    if (n.eql(p, n.ONE))
      return { x: w, y: E };
    const O = R.is0();
    u == null && (u = O ? n.ONE : n.inv(p));
    const B = n.mul(w, u), m = n.mul(E, u), b = n.mul(p, u);
    if (O)
      return { x: n.ZERO, y: n.ZERO };
    if (!n.eql(b, n.ONE))
      throw new Error("invZ was invalid");
    return { x: B, y: m };
  }), je = re((R) => {
    if (R.is0()) {
      if (t.allowInfinityPoint && !n.is0(R.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x: u, y: w } = R.toAffine();
    if (!n.isValid(u) || !n.isValid(w))
      throw new Error("bad point: x or y not field elements");
    if (!L(u, w))
      throw new Error("bad point: equation left != right");
    if (!R.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return !0;
  });
  function Jt(R, u, w, E, p) {
    return w = new W(n.mul(w.X, R), w.Y, w.Z), u = Et(E, u), w = Et(p, w), u.add(w);
  }
  const $ = class $ {
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(u, w, E) {
      y(this, "X");
      y(this, "Y");
      y(this, "Z");
      this.X = P("x", u), this.Y = P("y", w, !0), this.Z = P("z", E), Object.freeze(this);
    }
    static CURVE() {
      return i;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(u) {
      const { x: w, y: E } = u || {};
      if (!u || !n.isValid(w) || !n.isValid(E))
        throw new Error("invalid affine point");
      if (u instanceof $)
        throw new Error("projective point not allowed");
      return n.is0(w) && n.is0(E) ? $.ZERO : new $(w, E, n.ONE);
    }
    static fromBytes(u) {
      const w = $.fromAffine(A(Z(u, void 0, "point")));
      return w.assertValidity(), w;
    }
    static fromHex(u) {
      return $.fromBytes(C(u));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     *
     * @param windowSize
     * @param isLazy true will defer table computation until the first multiplication
     * @returns
     */
    precompute(u = 8, w = !0) {
      return ot.createCache(this, u), w || this.multiply(wt), this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      je(this);
    }
    hasEvenY() {
      const { y: u } = this.toAffine();
      if (!n.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !n.isOdd(u);
    }
    /** Compare one point to another. */
    equals(u) {
      dt(u);
      const { X: w, Y: E, Z: p } = this, { X: O, Y: B, Z: m } = u, b = n.eql(n.mul(w, m), n.mul(O, p)), x = n.eql(n.mul(E, m), n.mul(B, p));
      return b && x;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new $(this.X, n.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a: u, b: w } = i, E = n.mul(w, wt), { X: p, Y: O, Z: B } = this;
      let m = n.ZERO, b = n.ZERO, x = n.ZERO, v = n.mul(p, p), V = n.mul(O, O), N = n.mul(B, B), S = n.mul(p, O);
      return S = n.add(S, S), x = n.mul(p, B), x = n.add(x, x), m = n.mul(u, x), b = n.mul(E, N), b = n.add(m, b), m = n.sub(V, b), b = n.add(V, b), b = n.mul(m, b), m = n.mul(S, m), x = n.mul(E, x), N = n.mul(u, N), S = n.sub(v, N), S = n.mul(u, S), S = n.add(S, x), x = n.add(v, v), v = n.add(x, v), v = n.add(v, N), v = n.mul(v, S), b = n.add(b, v), N = n.mul(O, B), N = n.add(N, N), v = n.mul(N, S), m = n.sub(m, v), x = n.mul(N, V), x = n.add(x, x), x = n.add(x, x), new $(m, b, x);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(u) {
      dt(u);
      const { X: w, Y: E, Z: p } = this, { X: O, Y: B, Z: m } = u;
      let b = n.ZERO, x = n.ZERO, v = n.ZERO;
      const V = i.a, N = n.mul(i.b, wt);
      let S = n.mul(w, O), H = n.mul(E, B), Y = n.mul(p, m), tt = n.add(w, E), q = n.add(O, B);
      tt = n.mul(tt, q), q = n.add(S, H), tt = n.sub(tt, q), q = n.add(w, p);
      let j = n.add(O, m);
      return q = n.mul(q, j), j = n.add(S, Y), q = n.sub(q, j), j = n.add(E, p), b = n.add(B, m), j = n.mul(j, b), b = n.add(H, Y), j = n.sub(j, b), v = n.mul(V, q), b = n.mul(N, Y), v = n.add(b, v), b = n.sub(H, v), v = n.add(H, v), x = n.mul(b, v), H = n.add(S, S), H = n.add(H, S), Y = n.mul(V, Y), q = n.mul(N, q), H = n.add(H, Y), Y = n.sub(S, Y), Y = n.mul(V, Y), q = n.add(q, Y), S = n.mul(H, q), x = n.add(x, S), S = n.mul(j, q), b = n.mul(tt, b), b = n.sub(b, S), S = n.mul(tt, H), v = n.mul(j, v), v = n.add(v, S), new $(b, x, v);
    }
    subtract(u) {
      return this.add(u.negate());
    }
    is0() {
      return this.equals($.ZERO);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(u) {
      const { endo: w } = t;
      if (!o.isValidNot0(u))
        throw new Error("invalid scalar: out of range");
      let E, p;
      const O = (B) => ot.cached(this, B, (m) => se($, m));
      if (w) {
        const { k1neg: B, k1: m, k2neg: b, k2: x } = lt(u), { p: v, f: V } = O(m), { p: N, f: S } = O(x);
        p = V.add(S), E = Jt(w.beta, v, N, B, b);
      } else {
        const { p: B, f: m } = O(u);
        E = B, p = m;
      }
      return se($, [E, p])[0];
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed secret key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(u) {
      const { endo: w } = t, E = this;
      if (!o.isValid(u))
        throw new Error("invalid scalar: out of range");
      if (u === ct || E.is0())
        return $.ZERO;
      if (u === bt)
        return E;
      if (ot.hasCache(this))
        return this.multiply(u);
      if (w) {
        const { k1neg: p, k1: O, k2neg: B, k2: m } = lt(u), { p1: b, p2: x } = vn($, E, O, m);
        return Jt(w.beta, b, x, p, B);
      } else
        return ot.unsafe(E, u);
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(u) {
      return ht(this, u);
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      const { isTorsionFree: u } = t;
      return s === bt ? !0 : u ? u($, this) : ot.unsafe(this, c).is0();
    }
    clearCofactor() {
      const { clearCofactor: u } = t;
      return s === bt ? this : u ? u($, this) : this.multiplyUnsafe(s);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(s).is0();
    }
    toBytes(u = !0) {
      return ne(u, "isCompressed"), this.assertValidity(), g($, this, u);
    }
    toHex(u = !0) {
      return T(this.toBytes(u));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  };
  // base / generator point
  y($, "BASE", new $(i.Gx, i.Gy, n.ONE)), // zero / infinity / identity point
  y($, "ZERO", new $(n.ZERO, n.ONE, n.ZERO)), // 0, 1, 0
  // math field
  y($, "Fp", n), // scalar field
  y($, "Fn", o);
  let W = $;
  const Qt = o.BITS, ot = new Bn(W, t.endo ? Math.ceil(Qt / 2) : Qt);
  return W.BASE.precompute(8), W;
}
function Nn(e) {
  return Uint8Array.of(e ? 2 : 3);
}
function Ln(e, t) {
  return {
    secretKey: t.BYTES,
    publicKey: 1 + e.BYTES,
    publicKeyUncompressed: 1 + 2 * e.BYTES,
    publicKeyHasPrefix: !0,
    signature: 2 * t.BYTES
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const Rt = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
}, qn = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
}, _n = /* @__PURE__ */ BigInt(0), Vt = /* @__PURE__ */ BigInt(2);
function Tn(e) {
  const t = Rt.p, r = BigInt(3), n = BigInt(6), o = BigInt(11), i = BigInt(22), s = BigInt(23), c = BigInt(44), f = BigInt(88), d = e * e * e % t, l = d * d * e % t, a = D(l, r, t) * l % t, h = D(a, r, t) * l % t, g = D(h, Vt, t) * d % t, A = D(g, o, t) * g % t, I = D(A, i, t) * A % t, L = D(I, c, t) * I % t, k = D(L, f, t) * L % t, Q = D(k, c, t) * I % t, P = D(Q, r, t) * l % t, dt = D(P, s, t) * A % t, lt = D(dt, n, t) * d % t, ht = D(lt, Vt, t);
  if (!pt.eql(pt.sqr(ht), e))
    throw new Error("Cannot find square root");
  return ht;
}
const pt = At(Rt.p, { sqrt: Tn }), rt = /* @__PURE__ */ $n(Rt, {
  Fp: pt,
  endo: qn
}), de = {};
function mt(e, ...t) {
  let r = de[e];
  if (r === void 0) {
    const n = Zt(cn(e));
    r = at(n, n), de[e] = r;
  }
  return Zt(at(r, ...t));
}
const Gt = (e) => e.toBytes(!0).slice(1), Xt = (e) => e % Vt === _n;
function Dt(e) {
  const { Fn: t, BASE: r } = rt, n = t.fromBytes(e), o = r.multiply(n);
  return { scalar: Xt(o.y) ? n : t.neg(n), bytes: Gt(o) };
}
function Te(e) {
  const t = pt;
  if (!t.isValidNot0(e))
    throw new Error("invalid x: Fail if x ≥ p");
  const r = t.create(e * e), n = t.create(r * e + BigInt(7));
  let o = t.sqrt(n);
  Xt(o) || (o = t.neg(o));
  const i = rt.fromAffine({ x: e, y: o });
  return i.assertValidity(), i;
}
const ft = Kt;
function Ue(...e) {
  return rt.Fn.create(ft(mt("BIP0340/challenge", ...e)));
}
function le(e) {
  return Dt(e).bytes;
}
function Un(e, t, r = ye(32)) {
  const { Fn: n } = rt, o = Z(e, void 0, "message"), { bytes: i, scalar: s } = Dt(t), c = Z(r, 32, "auxRand"), f = n.toBytes(s ^ ft(mt("BIP0340/aux", c))), d = mt("BIP0340/nonce", f, i, o), { bytes: l, scalar: a } = Dt(d), h = Ue(l, i, o), g = new Uint8Array(64);
  if (g.set(l, 0), g.set(n.toBytes(n.create(a + h * s)), 32), !Ze(g, o, i))
    throw new Error("sign: Invalid signature produced");
  return g;
}
function Ze(e, t, r) {
  const { Fp: n, Fn: o, BASE: i } = rt, s = Z(e, 64, "signature"), c = Z(t, void 0, "message"), f = Z(r, 32, "publicKey");
  try {
    const d = Te(ft(f)), l = ft(s.subarray(0, 32));
    if (!n.isValidNot0(l))
      return !1;
    const a = ft(s.subarray(32, 64));
    if (!o.isValidNot0(a))
      return !1;
    const h = Ue(o.toBytes(l), Gt(d), c), g = i.multiplyUnsafe(a).add(d.multiplyUnsafe(o.neg(h))), { x: A, y: I } = g.toAffine();
    return !(g.is0() || !Xt(I) || A !== l);
  } catch {
    return !1;
  }
}
const it = /* @__PURE__ */ (() => {
  const r = (n = ye(48)) => xn(n, Rt.n);
  return {
    keygen: Rn(r, le),
    getPublicKey: le,
    sign: Un,
    verify: Ze,
    Point: rt,
    utils: {
      randomSecretKey: r,
      taggedHash: mt,
      lift_x: Te,
      pointToBytes: Gt
    },
    lengths: {
      secretKey: 32,
      publicKey: 32,
      publicKeyHasPrefix: !1,
      signature: 32 * 2,
      seed: 48
    }
  };
})();
var et = Symbol("verified"), Zn = (e) => e instanceof Object;
function kn(e) {
  if (!Zn(e) || typeof e.kind != "number" || typeof e.content != "string" || typeof e.created_at != "number" || typeof e.pubkey != "string" || !e.pubkey.match(/^[a-f0-9]{64}$/) || !Array.isArray(e.tags))
    return !1;
  for (let t = 0; t < e.tags.length; t++) {
    let r = e.tags[t];
    if (!Array.isArray(r))
      return !1;
    for (let n = 0; n < r.length; n++)
      if (typeof r[n] != "string")
        return !1;
  }
  return !0;
}
new TextDecoder("utf-8");
var Vn = new TextEncoder(), Dn = class {
  generateSecretKey() {
    return it.utils.randomSecretKey();
  }
  getPublicKey(e) {
    return T(it.getPublicKey(e));
  }
  finalizeEvent(e, t) {
    const r = e;
    return r.pubkey = T(it.getPublicKey(t)), r.id = _t(r), r.sig = T(it.sign(C(_t(r)), t)), r[et] = !0, r;
  }
  verifyEvent(e) {
    if (typeof e[et] == "boolean")
      return e[et];
    try {
      const t = _t(e);
      if (t !== e.id)
        return e[et] = !1, !1;
      const r = it.verify(C(e.sig), C(t), C(e.pubkey));
      return e[et] = r, r;
    } catch {
      return e[et] = !1, !1;
    }
  }
};
function Cn(e) {
  if (!kn(e))
    throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}
function _t(e) {
  let t = Zt(Vn.encode(Cn(e)));
  return T(t);
}
var It = new Dn();
It.generateSecretKey;
var or = It.getPublicKey, ir = It.finalizeEvent, sr = It.verifyEvent;
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function ke(e) {
  return e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array";
}
function Ve(e, t) {
  return Array.isArray(t) ? t.length === 0 ? !0 : e ? t.every((r) => typeof r == "string") : t.every((r) => Number.isSafeInteger(r)) : !1;
}
function Hn(e) {
  if (typeof e != "function")
    throw new Error("function expected");
  return !0;
}
function ut(e, t) {
  if (typeof t != "string")
    throw new Error(`${e}: string expected`);
  return !0;
}
function De(e) {
  if (!Number.isSafeInteger(e))
    throw new Error(`invalid integer: ${e}`);
}
function Ct(e) {
  if (!Array.isArray(e))
    throw new Error("array expected");
}
function Ce(e, t) {
  if (!Ve(!0, t))
    throw new Error(`${e}: array of strings expected`);
}
function He(e, t) {
  if (!Ve(!1, t))
    throw new Error(`${e}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function Yn(...e) {
  const t = (i) => i, r = (i, s) => (c) => i(s(c)), n = e.map((i) => i.encode).reduceRight(r, t), o = e.map((i) => i.decode).reduce(r, t);
  return { encode: n, decode: o };
}
// @__NO_SIDE_EFFECTS__
function zn(e) {
  const t = typeof e == "string" ? e.split("") : e, r = t.length;
  Ce("alphabet", t);
  const n = new Map(t.map((o, i) => [o, i]));
  return {
    encode: (o) => (Ct(o), o.map((i) => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= r)
        throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${e}`);
      return t[i];
    })),
    decode: (o) => (Ct(o), o.map((i) => {
      ut("alphabet.decode", i);
      const s = n.get(i);
      if (s === void 0)
        throw new Error(`Unknown letter: "${i}". Allowed: ${e}`);
      return s;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function jn(e = "") {
  return ut("join", e), {
    encode: (t) => (Ce("join.decode", t), t.join(e)),
    decode: (t) => (ut("join.decode", t), t.split(e))
  };
}
const Ye = (e, t) => t === 0 ? e : Ye(t, e % t), xt = /* @__NO_SIDE_EFFECTS__ */ (e, t) => e + (t - Ye(e, t)), yt = /* @__PURE__ */ (() => {
  let e = [];
  for (let t = 0; t < 40; t++)
    e.push(2 ** t);
  return e;
})();
function Ht(e, t, r, n) {
  if (Ct(e), t <= 0 || t > 32)
    throw new Error(`convertRadix2: wrong from=${t}`);
  if (r <= 0 || r > 32)
    throw new Error(`convertRadix2: wrong to=${r}`);
  if (/* @__PURE__ */ xt(t, r) > 32)
    throw new Error(`convertRadix2: carry overflow from=${t} to=${r} carryBits=${/* @__PURE__ */ xt(t, r)}`);
  let o = 0, i = 0;
  const s = yt[t], c = yt[r] - 1, f = [];
  for (const d of e) {
    if (De(d), d >= s)
      throw new Error(`convertRadix2: invalid data word=${d} from=${t}`);
    if (o = o << t | d, i + t > 32)
      throw new Error(`convertRadix2: carry overflow pos=${i} from=${t}`);
    for (i += t; i >= r; i -= r)
      f.push((o >> i - r & c) >>> 0);
    const l = yt[i];
    if (l === void 0)
      throw new Error("invalid carry");
    o &= l - 1;
  }
  if (o = o << r - i & c, !n && i >= t)
    throw new Error("Excess padding");
  if (!n && o > 0)
    throw new Error(`Non-zero padding: ${o}`);
  return n && i > 0 && f.push(o >>> 0), f;
}
// @__NO_SIDE_EFFECTS__
function Kn(e, t = !1) {
  if (De(e), e <= 0 || e > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ xt(8, e) > 32 || /* @__PURE__ */ xt(e, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (r) => {
      if (!ke(r))
        throw new Error("radix2.encode input should be Uint8Array");
      return Ht(Array.from(r), 8, e, !t);
    },
    decode: (r) => (He("radix2.decode", r), Uint8Array.from(Ht(r, e, 8, t)))
  };
}
function he(e) {
  return Hn(e), function(...t) {
    try {
      return e.apply(null, t);
    } catch {
    }
  };
}
const Yt = /* @__PURE__ */ Yn(/* @__PURE__ */ zn("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /* @__PURE__ */ jn("")), we = [996825010, 642813549, 513874426, 1027748829, 705979059];
function st(e) {
  const t = e >> 25;
  let r = (e & 33554431) << 5;
  for (let n = 0; n < we.length; n++)
    (t >> n & 1) === 1 && (r ^= we[n]);
  return r;
}
function ge(e, t, r = 1) {
  const n = e.length;
  let o = 1;
  for (let i = 0; i < n; i++) {
    const s = e.charCodeAt(i);
    if (s < 33 || s > 126)
      throw new Error(`Invalid prefix (${e})`);
    o = st(o) ^ s >> 5;
  }
  o = st(o);
  for (let i = 0; i < n; i++)
    o = st(o) ^ e.charCodeAt(i) & 31;
  for (let i of t)
    o = st(o) ^ i;
  for (let i = 0; i < 6; i++)
    o = st(o);
  return o ^= r, Yt.encode(Ht([o % yt[30]], 30, 5, !1));
}
// @__NO_SIDE_EFFECTS__
function Mn(e) {
  const t = e === "bech32" ? 1 : 734539939, r = /* @__PURE__ */ Kn(5), n = r.decode, o = r.encode, i = he(n);
  function s(a, h, g = 90) {
    ut("bech32.encode prefix", a), ke(h) && (h = Array.from(h)), He("bech32.encode", h);
    const A = a.length;
    if (A === 0)
      throw new TypeError(`Invalid prefix length ${A}`);
    const I = A + 7 + h.length;
    if (g !== !1 && I > g)
      throw new TypeError(`Length ${I} exceeds limit ${g}`);
    const L = a.toLowerCase(), k = ge(L, h, t);
    return `${L}1${Yt.encode(h)}${k}`;
  }
  function c(a, h = 90) {
    ut("bech32.decode input", a);
    const g = a.length;
    if (g < 8 || h !== !1 && g > h)
      throw new TypeError(`invalid string length: ${g} (${a}). Expected (8..${h})`);
    const A = a.toLowerCase();
    if (a !== A && a !== a.toUpperCase())
      throw new Error("String must be lowercase or uppercase");
    const I = A.lastIndexOf("1");
    if (I === 0 || I === -1)
      throw new Error('Letter "1" must be present between prefix and data only');
    const L = A.slice(0, I), k = A.slice(I + 1);
    if (k.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const Q = Yt.decode(k).slice(0, -6), P = ge(L, Q, t);
    if (!k.endsWith(P))
      throw new Error(`Invalid checksum in ${a}: expected "${P}"`);
    return { prefix: L, words: Q };
  }
  const f = he(c);
  function d(a) {
    const { prefix: h, words: g } = c(a, !1);
    return { prefix: h, words: g, bytes: n(g) };
  }
  function l(a, h) {
    return s(a, o(h));
  }
  return {
    encode: s,
    decode: c,
    encodeFromBytes: l,
    decodeToBytes: d,
    decodeUnsafe: f,
    fromWords: n,
    fromWordsUnsafe: i,
    toWords: o
  };
}
const Bt = /* @__PURE__ */ Mn("bech32");
var gt = new TextDecoder("utf-8"), vt = new TextEncoder(), Pn = {
  isNProfile: (e) => /^nprofile1[a-z\d]+$/.test(e || ""),
  isNEvent: (e) => /^nevent1[a-z\d]+$/.test(e || ""),
  isNAddr: (e) => /^naddr1[a-z\d]+$/.test(e || ""),
  isNSec: (e) => /^nsec1[a-z\d]{58}$/.test(e || ""),
  isNPub: (e) => /^npub1[a-z\d]{58}$/.test(e || ""),
  isNote: (e) => /^note1[a-z\d]+$/.test(e || ""),
  isNcryptsec: (e) => /^ncryptsec1[a-z\d]+$/.test(e || "")
}, Wt = 5e3, Gn = /[\x21-\x7E]{1,83}1[023456789acdefghjklmnpqrstuvwxyz]{6,}/;
function Xn(e) {
  const t = new Uint8Array(4);
  return t[0] = e >> 24 & 255, t[1] = e >> 16 & 255, t[2] = e >> 8 & 255, t[3] = e & 255, t;
}
function Wn(e) {
  try {
    return e.startsWith("nostr:") && (e = e.substring(6)), ze(e);
  } catch {
    return { type: "invalid", data: null };
  }
}
function ze(e) {
  var o, i, s, c, f, d, l;
  let { prefix: t, words: r } = Bt.decode(e, Wt), n = new Uint8Array(Bt.fromWords(r));
  switch (t) {
    case "nprofile": {
      let a = Tt(n);
      if (!((o = a[0]) != null && o[0]))
        throw new Error("missing TLV 0 for nprofile");
      if (a[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      return {
        type: "nprofile",
        data: {
          pubkey: T(a[0][0]),
          relays: a[1] ? a[1].map((h) => gt.decode(h)) : []
        }
      };
    }
    case "nevent": {
      let a = Tt(n);
      if (!((i = a[0]) != null && i[0]))
        throw new Error("missing TLV 0 for nevent");
      if (a[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      if (a[2] && a[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (a[3] && a[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "nevent",
        data: {
          id: T(a[0][0]),
          relays: a[1] ? a[1].map((h) => gt.decode(h)) : [],
          author: (s = a[2]) != null && s[0] ? T(a[2][0]) : void 0,
          kind: (c = a[3]) != null && c[0] ? parseInt(T(a[3][0]), 16) : void 0
        }
      };
    }
    case "naddr": {
      let a = Tt(n);
      if (!((f = a[0]) != null && f[0]))
        throw new Error("missing TLV 0 for naddr");
      if (!((d = a[2]) != null && d[0]))
        throw new Error("missing TLV 2 for naddr");
      if (a[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (!((l = a[3]) != null && l[0]))
        throw new Error("missing TLV 3 for naddr");
      if (a[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "naddr",
        data: {
          identifier: gt.decode(a[0][0]),
          pubkey: T(a[2][0]),
          kind: parseInt(T(a[3][0]), 16),
          relays: a[1] ? a[1].map((h) => gt.decode(h)) : []
        }
      };
    }
    case "nsec":
      return { type: t, data: n };
    case "npub":
    case "note":
      return { type: t, data: T(n) };
    default:
      throw new Error(`unknown prefix ${t}`);
  }
}
function Tt(e) {
  let t = {}, r = e;
  for (; r.length > 0; ) {
    let n = r[0], o = r[1], i = r.slice(2, 2 + o);
    if (r = r.slice(2 + o), i.length < o)
      throw new Error(`not enough data to read on TLV ${n}`);
    t[n] = t[n] || [], t[n].push(i);
  }
  return t;
}
function Fn(e) {
  return St("nsec", e);
}
function Jn(e) {
  return St("npub", C(e));
}
function Qn(e) {
  return St("note", C(e));
}
function Ot(e, t) {
  let r = Bt.toWords(t);
  return Bt.encode(e, r, Wt);
}
function St(e, t) {
  return Ot(e, t);
}
function tr(e) {
  let t = Ft({
    0: [C(e.pubkey)],
    1: (e.relays || []).map((r) => vt.encode(r))
  });
  return Ot("nprofile", t);
}
function er(e) {
  let t;
  e.kind !== void 0 && (t = Xn(e.kind));
  let r = Ft({
    0: [C(e.id)],
    1: (e.relays || []).map((n) => vt.encode(n)),
    2: e.author ? [C(e.author)] : [],
    3: t ? [new Uint8Array(t)] : []
  });
  return Ot("nevent", r);
}
function nr(e) {
  let t = new ArrayBuffer(4);
  new DataView(t).setUint32(0, e.kind, !1);
  let r = Ft({
    0: [vt.encode(e.identifier)],
    1: (e.relays || []).map((n) => vt.encode(n)),
    2: [C(e.pubkey)],
    3: [new Uint8Array(t)]
  });
  return Ot("naddr", r);
}
function Ft(e) {
  let t = [];
  return Object.entries(e).reverse().forEach(([r, n]) => {
    n.forEach((o) => {
      let i = new Uint8Array(o.length + 2);
      i.set([parseInt(r)], 0), i.set([o.length], 1), i.set(o, 2), t.push(i);
    });
  }), at(...t);
}
const cr = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  BECH32_REGEX: Gn,
  Bech32MaxSize: Wt,
  NostrTypeGuard: Pn,
  decode: ze,
  decodeNostrURI: Wn,
  encodeBytes: St,
  naddrEncode: nr,
  neventEncode: er,
  noteEncode: Qn,
  nprofileEncode: tr,
  npubEncode: Jn,
  nsecEncode: Fn
}, Symbol.toStringTag, { value: "Module" }));
export {
  ir as finalizeEvent,
  or as getPublicKey,
  cr as nip19,
  sr as verifyEvent
};
