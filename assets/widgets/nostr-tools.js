var Jt = Object.defineProperty;
var Qt = (t, e, r) => e in t ? Jt(t, e, { enumerable: !0, configurable: !0, writable: !0, value: r }) : t[e] = r;
var f = (t, e, r) => Qt(t, typeof e != "symbol" ? e + "" : e, r);
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function en(t) {
  return t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array";
}
function Ke(t, e = "") {
  if (!Number.isSafeInteger(t) || t < 0) {
    const r = e && `"${e}" `;
    throw new Error(`${r}expected integer >= 0, got ${t}`);
  }
}
function H(t, e, r = "") {
  const n = en(t), i = t == null ? void 0 : t.length, o = e !== void 0;
  if (!n || o && i !== e) {
    const c = r && `"${r}" `, s = o ? ` of length ${e}` : "", a = n ? `length=${i}` : `type=${typeof t}`;
    throw new Error(c + "expected Uint8Array" + s + ", got " + a);
  }
  return t;
}
function it(t, e = !0) {
  if (t.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && t.finished)
    throw new Error("Hash#digest() has already been called");
}
function tn(t, e) {
  H(t, void 0, "digestInto() output");
  const r = e.outputLen;
  if (t.length < r)
    throw new Error('"digestInto() output" expected to be of length >=' + r);
}
function Ve(...t) {
  for (let e = 0; e < t.length; e++)
    t[e].fill(0);
}
function Ne(t) {
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
}
function K(t, e) {
  return t << 32 - e | t >>> e;
}
const pt = /* @ts-ignore */ typeof Uint8Array.from([]).toHex == "function" && typeof Uint8Array.fromHex == "function", nn = /* @__PURE__ */ Array.from({ length: 256 }, (t, e) => e.toString(16).padStart(2, "0"));
function k(t) {
  if (H(t), pt)
    return t.toHex();
  let e = "";
  for (let r = 0; r < t.length; r++)
    e += nn[t[r]];
  return e;
}
const G = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function ot(t) {
  if (t >= G._0 && t <= G._9)
    return t - G._0;
  if (t >= G.A && t <= G.F)
    return t - (G.A - 10);
  if (t >= G.a && t <= G.f)
    return t - (G.a - 10);
}
function N(t) {
  if (typeof t != "string")
    throw new Error("hex string expected, got " + typeof t);
  if (pt)
    return Uint8Array.fromHex(t);
  const e = t.length, r = e / 2;
  if (e % 2)
    throw new Error("hex string expected, got unpadded hex of length " + e);
  const n = new Uint8Array(r);
  for (let i = 0, o = 0; i < r; i++, o += 2) {
    const c = ot(t.charCodeAt(o)), s = ot(t.charCodeAt(o + 1));
    if (c === void 0 || s === void 0) {
      const a = t[o] + t[o + 1];
      throw new Error('hex string expected, got non-hex character "' + a + '" at index ' + o);
    }
    n[i] = c * 16 + s;
  }
  return n;
}
function he(...t) {
  let e = 0;
  for (let n = 0; n < t.length; n++) {
    const i = t[n];
    H(i), e += i.length;
  }
  const r = new Uint8Array(e);
  for (let n = 0, i = 0; n < t.length; n++) {
    const o = t[n];
    r.set(o, i), i += o.length;
  }
  return r;
}
function rn(t, e = {}) {
  const r = (i, o) => t(o).update(i).digest(), n = t(void 0);
  return r.outputLen = n.outputLen, r.blockLen = n.blockLen, r.create = (i) => t(i), Object.assign(r, e), Object.freeze(r);
}
function xt(t = 32) {
  const e = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (e == null ? void 0 : e.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return e.getRandomValues(new Uint8Array(t));
}
const on = (t) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, t])
});
function sn(t, e, r) {
  return t & e ^ ~t & r;
}
function cn(t, e, r) {
  return t & e ^ t & r ^ e & r;
}
class an {
  constructor(e, r, n, i) {
    f(this, "blockLen");
    f(this, "outputLen");
    f(this, "padOffset");
    f(this, "isLE");
    // For partial updates less than block size
    f(this, "buffer");
    f(this, "view");
    f(this, "finished", !1);
    f(this, "length", 0);
    f(this, "pos", 0);
    f(this, "destroyed", !1);
    this.blockLen = e, this.outputLen = r, this.padOffset = n, this.isLE = i, this.buffer = new Uint8Array(e), this.view = Ne(this.buffer);
  }
  update(e) {
    it(this), H(e);
    const { view: r, buffer: n, blockLen: i } = this, o = e.length;
    for (let c = 0; c < o; ) {
      const s = Math.min(i - this.pos, o - c);
      if (s === i) {
        const a = Ne(e);
        for (; i <= o - c; c += i)
          this.process(a, c);
        continue;
      }
      n.set(e.subarray(c, c + s), this.pos), this.pos += s, c += s, this.pos === i && (this.process(r, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    it(this), tn(e, this), this.finished = !0;
    const { buffer: r, view: n, blockLen: i, isLE: o } = this;
    let { pos: c } = this;
    r[c++] = 128, Ve(this.buffer.subarray(c)), this.padOffset > i - c && (this.process(n, 0), c = 0);
    for (let l = c; l < i; l++)
      r[l] = 0;
    n.setBigUint64(i - 8, BigInt(this.length * 8), o), this.process(n, 0);
    const s = Ne(e), a = this.outputLen;
    if (a % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const u = a / 4, b = this.get();
    if (u > b.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let l = 0; l < u; l++)
      s.setUint32(4 * l, b[l], o);
  }
  digest() {
    const { buffer: e, outputLen: r } = this;
    this.digestInto(e);
    const n = e.slice(0, r);
    return this.destroy(), n;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: r, buffer: n, length: i, finished: o, destroyed: c, pos: s } = this;
    return e.destroyed = c, e.finished = o, e.length = i, e.pos = s, i % r && e.buffer.set(n), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const J = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), un = /* @__PURE__ */ Uint32Array.from([
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
]), Q = /* @__PURE__ */ new Uint32Array(64);
class ln extends an {
  constructor(e) {
    super(64, e, 8, !1);
  }
  get() {
    const { A: e, B: r, C: n, D: i, E: o, F: c, G: s, H: a } = this;
    return [e, r, n, i, o, c, s, a];
  }
  // prettier-ignore
  set(e, r, n, i, o, c, s, a) {
    this.A = e | 0, this.B = r | 0, this.C = n | 0, this.D = i | 0, this.E = o | 0, this.F = c | 0, this.G = s | 0, this.H = a | 0;
  }
  process(e, r) {
    for (let l = 0; l < 16; l++, r += 4)
      Q[l] = e.getUint32(r, !1);
    for (let l = 16; l < 64; l++) {
      const h = Q[l - 15], g = Q[l - 2], w = K(h, 7) ^ K(h, 18) ^ h >>> 3, p = K(g, 17) ^ K(g, 19) ^ g >>> 10;
      Q[l] = p + Q[l - 7] + w + Q[l - 16] | 0;
    }
    let { A: n, B: i, C: o, D: c, E: s, F: a, G: u, H: b } = this;
    for (let l = 0; l < 64; l++) {
      const h = K(s, 6) ^ K(s, 11) ^ K(s, 25), g = b + h + sn(s, a, u) + un[l] + Q[l] | 0, p = (K(n, 2) ^ K(n, 13) ^ K(n, 22)) + cn(n, i, o) | 0;
      b = u, u = a, a = s, s = c + g | 0, c = o, o = i, i = n, n = g + p | 0;
    }
    n = n + this.A | 0, i = i + this.B | 0, o = o + this.C | 0, c = c + this.D | 0, s = s + this.E | 0, a = a + this.F | 0, u = u + this.G | 0, b = b + this.H | 0, this.set(n, i, o, c, s, a, u, b);
  }
  roundClean() {
    Ve(Q);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), Ve(this.buffer);
  }
}
class fn extends ln {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    f(this, "A", J[0] | 0);
    f(this, "B", J[1] | 0);
    f(this, "C", J[2] | 0);
    f(this, "D", J[3] | 0);
    f(this, "E", J[4] | 0);
    f(this, "F", J[5] | 0);
    f(this, "G", J[6] | 0);
    f(this, "H", J[7] | 0);
  }
}
const pe = /* @__PURE__ */ rn(
  () => new fn(),
  /* @__PURE__ */ on(1)
);
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const je = /* @__PURE__ */ BigInt(0), Ze = /* @__PURE__ */ BigInt(1);
function st(t, e = "") {
  if (typeof t != "boolean") {
    const r = e && `"${e}" `;
    throw new Error(r + "expected boolean, got type=" + typeof t);
  }
  return t;
}
function dn(t) {
  if (typeof t == "bigint") {
    if (!gn(t))
      throw new Error("positive bigint expected, got " + t);
  } else
    Ke(t);
  return t;
}
function vt(t) {
  if (typeof t != "string")
    throw new Error("hex string expected, got " + typeof t);
  return t === "" ? je : BigInt("0x" + t);
}
function Fe(t) {
  return vt(k(t));
}
function St(t) {
  return vt(k(hn(H(t)).reverse()));
}
function Ge(t, e) {
  Ke(e), t = dn(t);
  const r = N(t.toString(16).padStart(e * 2, "0"));
  if (r.length !== e)
    throw new Error("number too large");
  return r;
}
function Rt(t, e) {
  return Ge(t, e).reverse();
}
function hn(t) {
  return Uint8Array.from(t);
}
function bn(t) {
  return Uint8Array.from(t, (e, r) => {
    const n = e.charCodeAt(0);
    if (e.length !== 1 || n > 127)
      throw new Error(`string contains non-ASCII character "${t[r]}" with code ${n} at position ${r}`);
    return n;
  });
}
const gn = (t) => typeof t == "bigint" && je <= t;
function wn(t) {
  let e;
  for (e = 0; t > je; t >>= Ze, e += 1)
    ;
  return e;
}
const Bt = (t) => (Ze << BigInt(t)) - Ze;
function At(t, e = {}, r = {}) {
  if (!t || typeof t != "object")
    throw new Error("expected valid options object");
  function n(o, c, s) {
    const a = t[o];
    if (s && a === void 0)
      return;
    const u = typeof a;
    if (u !== c || a === null)
      throw new Error(`param "${o}" is invalid: expected ${c}, got ${u}`);
  }
  const i = (o, c) => Object.entries(o).forEach(([s, a]) => n(s, a, c));
  i(e, !1), i(r, !0);
}
function ct(t) {
  const e = /* @__PURE__ */ new WeakMap();
  return (r, ...n) => {
    const i = e.get(r);
    if (i !== void 0)
      return i;
    const o = t(r, ...n);
    return e.set(r, o), o;
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const L = /* @__PURE__ */ BigInt(0), P = /* @__PURE__ */ BigInt(1), ne = /* @__PURE__ */ BigInt(2), Ot = /* @__PURE__ */ BigInt(3), Tt = /* @__PURE__ */ BigInt(4), It = /* @__PURE__ */ BigInt(5), yn = /* @__PURE__ */ BigInt(7), _t = /* @__PURE__ */ BigInt(8), En = /* @__PURE__ */ BigInt(9), $t = /* @__PURE__ */ BigInt(16);
function z(t, e) {
  const r = t % e;
  return r >= L ? r : e + r;
}
function Z(t, e, r) {
  let n = t;
  for (; e-- > L; )
    n *= n, n %= r;
  return n;
}
function at(t, e) {
  if (t === L)
    throw new Error("invert: expected non-zero number");
  if (e <= L)
    throw new Error("invert: expected positive modulus, got " + e);
  let r = z(t, e), n = e, i = L, o = P;
  for (; r !== L; ) {
    const s = n / r, a = n % r, u = i - o * s;
    n = r, r = a, i = o, o = u;
  }
  if (n !== P)
    throw new Error("invert: does not exist");
  return z(i, e);
}
function Xe(t, e, r) {
  if (!t.eql(t.sqr(e), r))
    throw new Error("Cannot find square root");
}
function kt(t, e) {
  const r = (t.ORDER + P) / Tt, n = t.pow(e, r);
  return Xe(t, n, e), n;
}
function mn(t, e) {
  const r = (t.ORDER - It) / _t, n = t.mul(e, ne), i = t.pow(n, r), o = t.mul(e, i), c = t.mul(t.mul(o, ne), i), s = t.mul(o, t.sub(c, t.ONE));
  return Xe(t, s, e), s;
}
function pn(t) {
  const e = Oe(t), r = Nt(t), n = r(e, e.neg(e.ONE)), i = r(e, n), o = r(e, e.neg(n)), c = (t + yn) / $t;
  return (s, a) => {
    let u = s.pow(a, c), b = s.mul(u, n);
    const l = s.mul(u, i), h = s.mul(u, o), g = s.eql(s.sqr(b), a), w = s.eql(s.sqr(l), a);
    u = s.cmov(u, b, g), b = s.cmov(h, l, w);
    const p = s.eql(s.sqr(b), a), _ = s.cmov(u, b, p);
    return Xe(s, _, a), _;
  };
}
function Nt(t) {
  if (t < Ot)
    throw new Error("sqrt is not defined for small field");
  let e = t - P, r = 0;
  for (; e % ne === L; )
    e /= ne, r++;
  let n = ne;
  const i = Oe(t);
  for (; ut(i, n) === 1; )
    if (n++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  if (r === 1)
    return kt;
  let o = i.pow(n, e);
  const c = (e + P) / ne;
  return function(a, u) {
    if (a.is0(u))
      return u;
    if (ut(a, u) !== 1)
      throw new Error("Cannot find square root");
    let b = r, l = a.mul(a.ONE, o), h = a.pow(u, e), g = a.pow(u, c);
    for (; !a.eql(h, a.ONE); ) {
      if (a.is0(h))
        return a.ZERO;
      let w = 1, p = a.sqr(h);
      for (; !a.eql(p, a.ONE); )
        if (w++, p = a.sqr(p), w === b)
          throw new Error("Cannot find square root");
      const _ = P << BigInt(b - w - 1), q = a.pow(l, _);
      b = w, l = a.sqr(q), h = a.mul(h, l), g = a.mul(g, q);
    }
    return g;
  };
}
function xn(t) {
  return t % Tt === Ot ? kt : t % _t === It ? mn : t % $t === En ? pn(t) : Nt(t);
}
const vn = [
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
function Sn(t) {
  const e = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  }, r = vn.reduce((n, i) => (n[i] = "function", n), e);
  return At(t, r), t;
}
function Rn(t, e, r) {
  if (r < L)
    throw new Error("invalid exponent, negatives unsupported");
  if (r === L)
    return t.ONE;
  if (r === P)
    return e;
  let n = t.ONE, i = e;
  for (; r > L; )
    r & P && (n = t.mul(n, i)), i = t.sqr(i), r >>= P;
  return n;
}
function qt(t, e, r = !1) {
  const n = new Array(e.length).fill(r ? t.ZERO : void 0), i = e.reduce((c, s, a) => t.is0(s) ? c : (n[a] = c, t.mul(c, s)), t.ONE), o = t.inv(i);
  return e.reduceRight((c, s, a) => t.is0(s) ? c : (n[a] = t.mul(c, n[a]), t.mul(c, s)), o), n;
}
function ut(t, e) {
  const r = (t.ORDER - P) / ne, n = t.pow(e, r), i = t.eql(n, t.ONE), o = t.eql(n, t.ZERO), c = t.eql(n, t.neg(t.ONE));
  if (!i && !o && !c)
    throw new Error("invalid Legendre symbol result");
  return i ? 1 : o ? 0 : -1;
}
function Bn(t, e) {
  e !== void 0 && Ke(e);
  const r = e !== void 0 ? e : t.toString(2).length, n = Math.ceil(r / 8);
  return { nBitLength: r, nByteLength: n };
}
class An {
  constructor(e, r = {}) {
    f(this, "ORDER");
    f(this, "BITS");
    f(this, "BYTES");
    f(this, "isLE");
    f(this, "ZERO", L);
    f(this, "ONE", P);
    f(this, "_lengths");
    f(this, "_sqrt");
    // cached sqrt
    f(this, "_mod");
    var c;
    if (e <= L)
      throw new Error("invalid field: expected ORDER > 0, got " + e);
    let n;
    this.isLE = !1, r != null && typeof r == "object" && (typeof r.BITS == "number" && (n = r.BITS), typeof r.sqrt == "function" && (this.sqrt = r.sqrt), typeof r.isLE == "boolean" && (this.isLE = r.isLE), r.allowedLengths && (this._lengths = (c = r.allowedLengths) == null ? void 0 : c.slice()), typeof r.modFromBytes == "boolean" && (this._mod = r.modFromBytes));
    const { nBitLength: i, nByteLength: o } = Bn(e, n);
    if (o > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = e, this.BITS = i, this.BYTES = o, this._sqrt = void 0, Object.preventExtensions(this);
  }
  create(e) {
    return z(e, this.ORDER);
  }
  isValid(e) {
    if (typeof e != "bigint")
      throw new Error("invalid field element: expected bigint, got " + typeof e);
    return L <= e && e < this.ORDER;
  }
  is0(e) {
    return e === L;
  }
  // is valid and invertible
  isValidNot0(e) {
    return !this.is0(e) && this.isValid(e);
  }
  isOdd(e) {
    return (e & P) === P;
  }
  neg(e) {
    return z(-e, this.ORDER);
  }
  eql(e, r) {
    return e === r;
  }
  sqr(e) {
    return z(e * e, this.ORDER);
  }
  add(e, r) {
    return z(e + r, this.ORDER);
  }
  sub(e, r) {
    return z(e - r, this.ORDER);
  }
  mul(e, r) {
    return z(e * r, this.ORDER);
  }
  pow(e, r) {
    return Rn(this, e, r);
  }
  div(e, r) {
    return z(e * at(r, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(e) {
    return e * e;
  }
  addN(e, r) {
    return e + r;
  }
  subN(e, r) {
    return e - r;
  }
  mulN(e, r) {
    return e * r;
  }
  inv(e) {
    return at(e, this.ORDER);
  }
  sqrt(e) {
    return this._sqrt || (this._sqrt = xn(this.ORDER)), this._sqrt(this, e);
  }
  toBytes(e) {
    return this.isLE ? Rt(e, this.BYTES) : Ge(e, this.BYTES);
  }
  fromBytes(e, r = !1) {
    H(e);
    const { _lengths: n, BYTES: i, isLE: o, ORDER: c, _mod: s } = this;
    if (n) {
      if (!n.includes(e.length) || e.length > i)
        throw new Error("Field.fromBytes: expected " + n + " bytes, got " + e.length);
      const u = new Uint8Array(i);
      u.set(e, o ? 0 : u.length - e.length), e = u;
    }
    if (e.length !== i)
      throw new Error("Field.fromBytes: expected " + i + " bytes, got " + e.length);
    let a = o ? St(e) : Fe(e);
    if (s && (a = z(a, c)), !r && !this.isValid(a))
      throw new Error("invalid field element: outside of range 0..ORDER");
    return a;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(e) {
    return qt(this, e);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(e, r, n) {
    return n ? r : e;
  }
}
function Oe(t, e = {}) {
  return new An(t, e);
}
function Ct(t) {
  if (typeof t != "bigint")
    throw new Error("field order must be bigint");
  const e = t.toString(2).length;
  return Math.ceil(e / 8);
}
function On(t) {
  const e = Ct(t);
  return e + Math.ceil(e / 2);
}
function Tn(t, e, r = !1) {
  H(t);
  const n = t.length, i = Ct(e), o = On(e);
  if (n < 16 || n < o || n > 1024)
    throw new Error("expected " + o + "-1024 bytes of input, got " + n);
  const c = r ? St(t) : Fe(t), s = z(c, e - P) + P;
  return r ? Rt(s, i) : Ge(s, i);
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const se = /* @__PURE__ */ BigInt(0), re = /* @__PURE__ */ BigInt(1);
function xe(t, e) {
  const r = e.negate();
  return t ? r : e;
}
function lt(t, e) {
  const r = qt(t.Fp, e.map((n) => n.Z));
  return e.map((n, i) => t.fromAffine(n.toAffine(r[i])));
}
function Pt(t, e) {
  if (!Number.isSafeInteger(t) || t <= 0 || t > e)
    throw new Error("invalid window size, expected [1.." + e + "], got W=" + t);
}
function qe(t, e) {
  Pt(t, e);
  const r = Math.ceil(e / t) + 1, n = 2 ** (t - 1), i = 2 ** t, o = Bt(t), c = BigInt(t);
  return { windows: r, windowSize: n, mask: o, maxNumber: i, shiftBy: c };
}
function ft(t, e, r) {
  const { windowSize: n, mask: i, maxNumber: o, shiftBy: c } = r;
  let s = Number(t & i), a = t >> c;
  s > n && (s -= o, a += re);
  const u = e * n, b = u + Math.abs(s) - 1, l = s === 0, h = s < 0, g = e % 2 !== 0;
  return { nextN: a, offset: b, isZero: l, isNeg: h, isNegF: g, offsetF: u };
}
const Ce = /* @__PURE__ */ new WeakMap(), Lt = /* @__PURE__ */ new WeakMap();
function Pe(t) {
  return Lt.get(t) || 1;
}
function dt(t) {
  if (t !== se)
    throw new Error("invalid wNAF");
}
class In {
  // Parametrized with a given Point class (not individual point)
  constructor(e, r) {
    f(this, "BASE");
    f(this, "ZERO");
    f(this, "Fn");
    f(this, "bits");
    this.BASE = e.BASE, this.ZERO = e.ZERO, this.Fn = e.Fn, this.bits = r;
  }
  // non-const time multiplication ladder
  _unsafeLadder(e, r, n = this.ZERO) {
    let i = e;
    for (; r > se; )
      r & re && (n = n.add(i)), i = i.double(), r >>= re;
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
  precomputeWindow(e, r) {
    const { windows: n, windowSize: i } = qe(r, this.bits), o = [];
    let c = e, s = c;
    for (let a = 0; a < n; a++) {
      s = c, o.push(s);
      for (let u = 1; u < i; u++)
        s = s.add(c), o.push(s);
      c = s.double();
    }
    return o;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(e, r, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let i = this.ZERO, o = this.BASE;
    const c = qe(e, this.bits);
    for (let s = 0; s < c.windows; s++) {
      const { nextN: a, offset: u, isZero: b, isNeg: l, isNegF: h, offsetF: g } = ft(n, s, c);
      n = a, b ? o = o.add(xe(h, r[g])) : i = i.add(xe(l, r[u]));
    }
    return dt(n), { p: i, f: o };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(e, r, n, i = this.ZERO) {
    const o = qe(e, this.bits);
    for (let c = 0; c < o.windows && n !== se; c++) {
      const { nextN: s, offset: a, isZero: u, isNeg: b } = ft(n, c, o);
      if (n = s, !u) {
        const l = r[a];
        i = i.add(b ? l.negate() : l);
      }
    }
    return dt(n), i;
  }
  getPrecomputes(e, r, n) {
    let i = Ce.get(r);
    return i || (i = this.precomputeWindow(r, e), e !== 1 && (typeof n == "function" && (i = n(i)), Ce.set(r, i))), i;
  }
  cached(e, r, n) {
    const i = Pe(e);
    return this.wNAF(i, this.getPrecomputes(i, e, n), r);
  }
  unsafe(e, r, n, i) {
    const o = Pe(e);
    return o === 1 ? this._unsafeLadder(e, r, i) : this.wNAFUnsafe(o, this.getPrecomputes(o, e, n), r, i);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(e, r) {
    Pt(r, this.bits), Lt.set(e, r), Ce.delete(e);
  }
  hasCache(e) {
    return Pe(e) !== 1;
  }
}
function _n(t, e, r, n) {
  let i = e, o = t.ZERO, c = t.ZERO;
  for (; r > se || n > se; )
    r & re && (o = o.add(i)), n & re && (c = c.add(i)), i = i.double(), r >>= re, n >>= re;
  return { p1: o, p2: c };
}
function ht(t, e, r) {
  if (e) {
    if (e.ORDER !== t)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    return Sn(e), e;
  } else
    return Oe(t, { isLE: r });
}
function $n(t, e, r = {}, n) {
  if (n === void 0 && (n = t === "edwards"), !e || typeof e != "object")
    throw new Error(`expected valid ${t} CURVE object`);
  for (const a of ["p", "n", "h"]) {
    const u = e[a];
    if (!(typeof u == "bigint" && u > se))
      throw new Error(`CURVE.${a} must be positive bigint`);
  }
  const i = ht(e.p, r.Fp, n), o = ht(e.n, r.Fn, n), s = ["Gx", "Gy", "a", "b"];
  for (const a of s)
    if (!i.isValid(e[a]))
      throw new Error(`CURVE.${a} must be valid field element of CURVE.Fp`);
  return e = Object.freeze(Object.assign({}, e)), { CURVE: e, Fp: i, Fn: o };
}
function kn(t, e) {
  return function(n) {
    const i = t(n);
    return { secretKey: i, publicKey: e(i) };
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const bt = (t, e) => (t + (t >= 0 ? e : -e) / qn) / e;
function Nn(t, e, r) {
  const [[n, i], [o, c]] = e, s = bt(c * t, r), a = bt(-i * t, r);
  let u = t - s * n - a * o, b = -s * i - a * c;
  const l = u < le, h = b < le;
  l && (u = -u), h && (b = -b);
  const g = Bt(Math.ceil(wn(r) / 2)) + Ee;
  if (u < le || u >= g || b < le || b >= g)
    throw new Error("splitScalar (endomorphism): failed, k=" + t);
  return { k1neg: l, k1: u, k2neg: h, k2: b };
}
const le = BigInt(0), Ee = BigInt(1), qn = BigInt(2), we = BigInt(3), Cn = BigInt(4);
function Pn(t, e = {}) {
  const r = $n("weierstrass", t, e), { Fp: n, Fn: i } = r;
  let o = r.CURVE;
  const { h: c, n: s } = o;
  At(e, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  const { endo: a } = e;
  if (a && (!n.is0(o.a) || typeof a.beta != "bigint" || !Array.isArray(a.basises)))
    throw new Error('invalid endo: expected "beta": bigint and "basises": array');
  const u = Hn(n, i);
  function b() {
    if (!n.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function l(A, d, y) {
    const { x: m, y: x } = d.toAffine(), O = n.toBytes(m);
    if (st(y, "isCompressed"), y) {
      b();
      const R = !n.isOdd(x);
      return he(Ln(R), O);
    } else
      return he(Uint8Array.of(4), O, n.toBytes(x));
  }
  function h(A) {
    H(A, void 0, "Point");
    const { publicKey: d, publicKeyUncompressed: y } = u, m = A.length, x = A[0], O = A.subarray(1);
    if (m === d && (x === 2 || x === 3)) {
      const R = n.fromBytes(O);
      if (!n.isValid(R))
        throw new Error("bad point: is not on curve, wrong x");
      const v = p(R);
      let E;
      try {
        E = n.sqrt(v);
      } catch (V) {
        const $ = V instanceof Error ? ": " + V.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + $);
      }
      b();
      const S = n.isOdd(E);
      return (x & 1) === 1 !== S && (E = n.neg(E)), { x: R, y: E };
    } else if (m === y && x === 4) {
      const R = n.BYTES, v = n.fromBytes(O.subarray(0, R)), E = n.fromBytes(O.subarray(R, R * 2));
      if (!_(v, E))
        throw new Error("bad point: is not on curve");
      return { x: v, y: E };
    } else
      throw new Error(`bad point: got length ${m}, expected compressed=${d} or uncompressed=${y}`);
  }
  const g = e.toBytes || l, w = e.fromBytes || h;
  function p(A) {
    const d = n.sqr(A), y = n.mul(d, A);
    return n.add(n.add(y, n.mul(A, o.a)), o.b);
  }
  function _(A, d) {
    const y = n.sqr(d), m = p(A);
    return n.eql(y, m);
  }
  if (!_(o.Gx, o.Gy))
    throw new Error("bad curve params: generator point");
  const q = n.mul(n.pow(o.a, we), Cn), F = n.mul(n.sqr(o.b), BigInt(27));
  if (n.is0(n.add(q, F)))
    throw new Error("bad curve params: a or b");
  function D(A, d, y = !1) {
    if (!n.isValid(d) || y && n.is0(d))
      throw new Error(`bad point coordinate ${A}`);
    return d;
  }
  function U(A) {
    if (!(A instanceof ee))
      throw new Error("Weierstrass Point expected");
  }
  function X(A) {
    if (!a || !a.basises)
      throw new Error("no endo");
    return Nn(A, a.basises, i.ORDER);
  }
  const ge = ct((A, d) => {
    const { X: y, Y: m, Z: x } = A;
    if (n.eql(x, n.ONE))
      return { x: y, y: m };
    const O = A.is0();
    d == null && (d = O ? n.ONE : n.inv(x));
    const R = n.mul(y, d), v = n.mul(m, d), E = n.mul(x, d);
    if (O)
      return { x: n.ZERO, y: n.ZERO };
    if (!n.eql(E, n.ONE))
      throw new Error("invZ was invalid");
    return { x: R, y: v };
  }), Xt = ct((A) => {
    if (A.is0()) {
      if (e.allowInfinityPoint && !n.is0(A.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x: d, y } = A.toAffine();
    if (!n.isValid(d) || !n.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!_(d, y))
      throw new Error("bad point: equation left != right");
    if (!A.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return !0;
  });
  function nt(A, d, y, m, x) {
    return y = new ee(n.mul(y.X, A), y.Y, y.Z), d = xe(m, d), y = xe(x, y), d.add(y);
  }
  const I = class I {
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(d, y, m) {
      f(this, "X");
      f(this, "Y");
      f(this, "Z");
      this.X = D("x", d), this.Y = D("y", y, !0), this.Z = D("z", m), Object.freeze(this);
    }
    static CURVE() {
      return o;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(d) {
      const { x: y, y: m } = d || {};
      if (!d || !n.isValid(y) || !n.isValid(m))
        throw new Error("invalid affine point");
      if (d instanceof I)
        throw new Error("projective point not allowed");
      return n.is0(y) && n.is0(m) ? I.ZERO : new I(y, m, n.ONE);
    }
    static fromBytes(d) {
      const y = I.fromAffine(w(H(d, void 0, "point")));
      return y.assertValidity(), y;
    }
    static fromHex(d) {
      return I.fromBytes(N(d));
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
    precompute(d = 8, y = !0) {
      return ae.createCache(this, d), y || this.multiply(we), this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      Xt(this);
    }
    hasEvenY() {
      const { y: d } = this.toAffine();
      if (!n.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !n.isOdd(d);
    }
    /** Compare one point to another. */
    equals(d) {
      U(d);
      const { X: y, Y: m, Z: x } = this, { X: O, Y: R, Z: v } = d, E = n.eql(n.mul(y, v), n.mul(O, x)), S = n.eql(n.mul(m, v), n.mul(R, x));
      return E && S;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new I(this.X, n.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a: d, b: y } = o, m = n.mul(y, we), { X: x, Y: O, Z: R } = this;
      let v = n.ZERO, E = n.ZERO, S = n.ZERO, B = n.mul(x, x), V = n.mul(O, O), $ = n.mul(R, R), T = n.mul(x, O);
      return T = n.add(T, T), S = n.mul(x, R), S = n.add(S, S), v = n.mul(d, S), E = n.mul(m, $), E = n.add(v, E), v = n.sub(V, E), E = n.add(V, E), E = n.mul(v, E), v = n.mul(T, v), S = n.mul(m, S), $ = n.mul(d, $), T = n.sub(B, $), T = n.mul(d, T), T = n.add(T, S), S = n.add(B, B), B = n.add(S, B), B = n.add(B, $), B = n.mul(B, T), E = n.add(E, B), $ = n.mul(O, R), $ = n.add($, $), B = n.mul($, T), v = n.sub(v, B), S = n.mul($, V), S = n.add(S, S), S = n.add(S, S), new I(v, E, S);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(d) {
      U(d);
      const { X: y, Y: m, Z: x } = this, { X: O, Y: R, Z: v } = d;
      let E = n.ZERO, S = n.ZERO, B = n.ZERO;
      const V = o.a, $ = n.mul(o.b, we);
      let T = n.mul(y, O), W = n.mul(m, R), M = n.mul(x, v), ie = n.add(y, m), C = n.add(O, R);
      ie = n.mul(ie, C), C = n.add(T, W), ie = n.sub(ie, C), C = n.add(y, x);
      let Y = n.add(O, v);
      return C = n.mul(C, Y), Y = n.add(T, M), C = n.sub(C, Y), Y = n.add(m, x), E = n.add(R, v), Y = n.mul(Y, E), E = n.add(W, M), Y = n.sub(Y, E), B = n.mul(V, C), E = n.mul($, M), B = n.add(E, B), E = n.sub(W, B), B = n.add(W, B), S = n.mul(E, B), W = n.add(T, T), W = n.add(W, T), M = n.mul(V, M), C = n.mul($, C), W = n.add(W, M), M = n.sub(T, M), M = n.mul(V, M), C = n.add(C, M), T = n.mul(W, C), S = n.add(S, T), T = n.mul(Y, C), E = n.mul(ie, E), E = n.sub(E, T), T = n.mul(ie, W), B = n.mul(Y, B), B = n.add(B, T), new I(E, S, B);
    }
    subtract(d) {
      return this.add(d.negate());
    }
    is0() {
      return this.equals(I.ZERO);
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
    multiply(d) {
      const { endo: y } = e;
      if (!i.isValidNot0(d))
        throw new Error("invalid scalar: out of range");
      let m, x;
      const O = (R) => ae.cached(this, R, (v) => lt(I, v));
      if (y) {
        const { k1neg: R, k1: v, k2neg: E, k2: S } = X(d), { p: B, f: V } = O(v), { p: $, f: T } = O(S);
        x = V.add(T), m = nt(y.beta, B, $, R, E);
      } else {
        const { p: R, f: v } = O(d);
        m = R, x = v;
      }
      return lt(I, [m, x])[0];
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed secret key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(d) {
      const { endo: y } = e, m = this;
      if (!i.isValid(d))
        throw new Error("invalid scalar: out of range");
      if (d === le || m.is0())
        return I.ZERO;
      if (d === Ee)
        return m;
      if (ae.hasCache(this))
        return this.multiply(d);
      if (y) {
        const { k1neg: x, k1: O, k2neg: R, k2: v } = X(d), { p1: E, p2: S } = _n(I, m, O, v);
        return nt(y.beta, E, S, x, R);
      } else
        return ae.unsafe(m, d);
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(d) {
      return ge(this, d);
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      const { isTorsionFree: d } = e;
      return c === Ee ? !0 : d ? d(I, this) : ae.unsafe(this, s).is0();
    }
    clearCofactor() {
      const { clearCofactor: d } = e;
      return c === Ee ? this : d ? d(I, this) : this.multiplyUnsafe(c);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(c).is0();
    }
    toBytes(d = !0) {
      return st(d, "isCompressed"), this.assertValidity(), g(I, this, d);
    }
    toHex(d = !0) {
      return k(this.toBytes(d));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  };
  // base / generator point
  f(I, "BASE", new I(o.Gx, o.Gy, n.ONE)), // zero / infinity / identity point
  f(I, "ZERO", new I(n.ZERO, n.ONE, n.ZERO)), // 0, 1, 0
  // math field
  f(I, "Fp", n), // scalar field
  f(I, "Fn", i);
  let ee = I;
  const rt = i.BITS, ae = new In(ee, e.endo ? Math.ceil(rt / 2) : rt);
  return ee.BASE.precompute(8), ee;
}
function Ln(t) {
  return Uint8Array.of(t ? 2 : 3);
}
function Hn(t, e) {
  return {
    secretKey: e.BYTES,
    publicKey: 1 + t.BYTES,
    publicKeyUncompressed: 1 + 2 * t.BYTES,
    publicKeyHasPrefix: !0,
    signature: 2 * e.BYTES
  };
}
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const Te = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
}, Un = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
}, Vn = /* @__PURE__ */ BigInt(0), De = /* @__PURE__ */ BigInt(2);
function Zn(t) {
  const e = Te.p, r = BigInt(3), n = BigInt(6), i = BigInt(11), o = BigInt(22), c = BigInt(23), s = BigInt(44), a = BigInt(88), u = t * t * t % e, b = u * u * t % e, l = Z(b, r, e) * b % e, h = Z(l, r, e) * b % e, g = Z(h, De, e) * u % e, w = Z(g, i, e) * g % e, p = Z(w, o, e) * w % e, _ = Z(p, s, e) * p % e, q = Z(_, a, e) * _ % e, F = Z(q, s, e) * p % e, D = Z(F, r, e) * b % e, U = Z(D, c, e) * w % e, X = Z(U, n, e) * u % e, ge = Z(X, De, e);
  if (!ve.eql(ve.sqr(ge), t))
    throw new Error("Cannot find square root");
  return ge;
}
const ve = Oe(Te.p, { sqrt: Zn }), ce = /* @__PURE__ */ Pn(Te, {
  Fp: ve,
  endo: Un
}), gt = {};
function Se(t, ...e) {
  let r = gt[t];
  if (r === void 0) {
    const n = pe(bn(t));
    r = he(n, n), gt[t] = r;
  }
  return pe(he(r, ...e));
}
const Je = (t) => t.toBytes(!0).slice(1), Qe = (t) => t % De === Vn;
function We(t) {
  const { Fn: e, BASE: r } = ce, n = e.fromBytes(t), i = r.multiply(n);
  return { scalar: Qe(i.y) ? n : e.neg(n), bytes: Je(i) };
}
function Ht(t) {
  const e = ve;
  if (!e.isValidNot0(t))
    throw new Error("invalid x: Fail if x ≥ p");
  const r = e.create(t * t), n = e.create(r * t + BigInt(7));
  let i = e.sqrt(n);
  Qe(i) || (i = e.neg(i));
  const o = ce.fromAffine({ x: t, y: i });
  return o.assertValidity(), o;
}
const de = Fe;
function Ut(...t) {
  return ce.Fn.create(de(Se("BIP0340/challenge", ...t)));
}
function wt(t) {
  return We(t).bytes;
}
function Dn(t, e, r = xt(32)) {
  const { Fn: n } = ce, i = H(t, void 0, "message"), { bytes: o, scalar: c } = We(e), s = H(r, 32, "auxRand"), a = n.toBytes(c ^ de(Se("BIP0340/aux", s))), u = Se("BIP0340/nonce", a, o, i), { bytes: b, scalar: l } = We(u), h = Ut(b, o, i), g = new Uint8Array(64);
  if (g.set(b, 0), g.set(n.toBytes(n.create(l + h * c)), 32), !Vt(g, i, o))
    throw new Error("sign: Invalid signature produced");
  return g;
}
function Vt(t, e, r) {
  const { Fp: n, Fn: i, BASE: o } = ce, c = H(t, 64, "signature"), s = H(e, void 0, "message"), a = H(r, 32, "publicKey");
  try {
    const u = Ht(de(a)), b = de(c.subarray(0, 32));
    if (!n.isValidNot0(b))
      return !1;
    const l = de(c.subarray(32, 64));
    if (!i.isValidNot0(l))
      return !1;
    const h = Ut(i.toBytes(b), Je(u), s), g = o.multiplyUnsafe(l).add(u.multiplyUnsafe(i.neg(h))), { x: w, y: p } = g.toAffine();
    return !(g.is0() || !Qe(p) || w !== b);
  } catch {
    return !1;
  }
}
const j = /* @__PURE__ */ (() => {
  const r = (n = xt(48)) => Tn(n, Te.n);
  return {
    keygen: kn(r, wt),
    getPublicKey: wt,
    sign: Dn,
    verify: Vt,
    Point: ce,
    utils: {
      randomSecretKey: r,
      taggedHash: Se,
      lift_x: Ht,
      pointToBytes: Je
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
var te = Symbol("verified"), Wn = (t) => t instanceof Object;
function Mn(t) {
  if (!Wn(t) || typeof t.kind != "number" || typeof t.content != "string" || typeof t.created_at != "number" || typeof t.pubkey != "string" || !t.pubkey.match(/^[a-f0-9]{64}$/) || !Array.isArray(t.tags))
    return !1;
  for (let e = 0; e < t.tags.length; e++) {
    let r = t.tags[e];
    if (!Array.isArray(r))
      return !1;
    for (let n = 0; n < r.length; n++)
      if (typeof r[n] != "string")
        return !1;
  }
  return !0;
}
new TextDecoder("utf-8");
var zn = new TextEncoder();
function fe(t) {
  try {
    t.indexOf("://") === -1 && (t = "wss://" + t);
    let e = new URL(t);
    return e.protocol === "http:" ? e.protocol = "ws:" : e.protocol === "https:" && (e.protocol = "wss:"), e.pathname = e.pathname.replace(/\/+/g, "/"), e.pathname.endsWith("/") && (e.pathname = e.pathname.slice(0, -1)), (e.port === "80" && e.protocol === "ws:" || e.port === "443" && e.protocol === "wss:") && (e.port = ""), e.searchParams.sort(), e.hash = "", e.toString();
  } catch {
    throw new Error(`Invalid URL: ${t}`);
  }
}
var Yn = class {
  generateSecretKey() {
    return j.utils.randomSecretKey();
  }
  getPublicKey(e) {
    return k(j.getPublicKey(e));
  }
  finalizeEvent(e, r) {
    const n = e;
    return n.pubkey = k(j.getPublicKey(r)), n.id = Le(n), n.sig = k(j.sign(N(Le(n)), r)), n[te] = !0, n;
  }
  verifyEvent(e) {
    if (typeof e[te] == "boolean")
      return e[te];
    try {
      const r = Le(e);
      if (r !== e.id)
        return e[te] = !1, !1;
      const n = j.verify(N(e.sig), N(r), N(e.pubkey));
      return e[te] = n, n;
    } catch {
      return e[te] = !1, !1;
    }
  }
};
function Kn(t) {
  if (!Mn(t))
    throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([0, t.pubkey, t.created_at, t.kind, t.tags, t.content]);
}
function Le(t) {
  let e = pe(zn.encode(Kn(t)));
  return k(e);
}
var Ie = new Yn();
Ie.generateSecretKey;
Ie.getPublicKey;
Ie.finalizeEvent;
var jn = Ie.verifyEvent, Fn = 22242;
function Gn(t, e) {
  if (t.ids && t.ids.indexOf(e.id) === -1 || t.kinds && t.kinds.indexOf(e.kind) === -1 || t.authors && t.authors.indexOf(e.pubkey) === -1)
    return !1;
  for (let r in t)
    if (r[0] === "#") {
      let n = r.slice(1), i = t[`#${n}`];
      if (i && !e.tags.find(([o, c]) => o === r.slice(1) && i.indexOf(c) !== -1))
        return !1;
    }
  return !(t.since && e.created_at < t.since || t.until && e.created_at > t.until);
}
function Xn(t, e) {
  for (let r = 0; r < t.length; r++)
    if (Gn(t[r], e))
      return !0;
  return !1;
}
function Jn(t, e) {
  let r = e.length + 3, n = t.indexOf(`"${e}":`) + r, i = t.slice(n).indexOf('"') + n + 1;
  return t.slice(i, i + 64);
}
function Qn(t) {
  let e = t.slice(0, 22).indexOf('"EVENT"');
  if (e === -1)
    return null;
  let r = t.slice(e + 7 + 1).indexOf('"');
  if (r === -1)
    return null;
  let n = e + 7 + 1 + r, i = t.slice(n + 1, 80).indexOf('"');
  if (i === -1)
    return null;
  let o = n + 1 + i;
  return t.slice(n + 1, o);
}
function er(t, e) {
  return {
    kind: Fn,
    created_at: Math.floor(Date.now() / 1e3),
    tags: [
      ["relay", t],
      ["challenge", e]
    ],
    content: ""
  };
}
var Zt = class extends Error {
  constructor(t, e) {
    super(`Tried to send message '${t} on a closed connection to ${e}.`), this.name = "SendingOnClosedConnection";
  }
}, Dt = class {
  constructor(t, e) {
    f(this, "url");
    f(this, "_connected", !1);
    f(this, "onclose", null);
    f(this, "onnotice", (t) => console.debug(`NOTICE from ${this.url}: ${t}`));
    f(this, "onauth");
    f(this, "baseEoseTimeout", 4400);
    f(this, "publishTimeout", 4400);
    f(this, "pingFrequency", 29e3);
    f(this, "pingTimeout", 2e4);
    f(this, "resubscribeBackoff", [1e4, 1e4, 1e4, 2e4, 2e4, 3e4, 6e4]);
    f(this, "openSubs", /* @__PURE__ */ new Map());
    f(this, "enablePing");
    f(this, "enableReconnect");
    f(this, "idleSince", Date.now());
    f(this, "ongoingOperations", 0);
    f(this, "reconnectTimeoutHandle");
    f(this, "pingIntervalHandle");
    f(this, "reconnectAttempts", 0);
    f(this, "skipReconnection", !1);
    f(this, "connectionPromise");
    f(this, "openCountRequests", /* @__PURE__ */ new Map());
    f(this, "openEventPublishes", /* @__PURE__ */ new Map());
    f(this, "ws");
    f(this, "challenge");
    f(this, "authPromise");
    f(this, "serial", 0);
    f(this, "verifyEvent");
    f(this, "_WebSocket");
    this.url = fe(t), this.verifyEvent = e.verifyEvent, this._WebSocket = e.websocketImplementation || WebSocket, this.enablePing = e.enablePing, this.enableReconnect = e.enableReconnect || !1;
  }
  static async connect(t, e) {
    const r = new Dt(t, e);
    return await r.connect(e), r;
  }
  closeAllSubscriptions(t) {
    for (let [e, r] of this.openSubs)
      r.close(t);
    this.openSubs.clear();
    for (let [e, r] of this.openEventPublishes)
      r.reject(new Error(t));
    this.openEventPublishes.clear();
    for (let [e, r] of this.openCountRequests)
      r.reject(new Error(t));
    this.openCountRequests.clear();
  }
  get connected() {
    return this._connected;
  }
  async reconnect() {
    const t = this.resubscribeBackoff[Math.min(this.reconnectAttempts, this.resubscribeBackoff.length - 1)];
    this.reconnectAttempts++, this.reconnectTimeoutHandle = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
      }
    }, t);
  }
  handleHardClose(t) {
    var e;
    this.pingIntervalHandle && (clearInterval(this.pingIntervalHandle), this.pingIntervalHandle = void 0), this._connected = !1, this.connectionPromise = void 0, this.idleSince = void 0, this.enableReconnect && !this.skipReconnection ? this.reconnect() : ((e = this.onclose) == null || e.call(this), this.closeAllSubscriptions(t));
  }
  async connect(t) {
    let e;
    return this.connectionPromise ? this.connectionPromise : (this.challenge = void 0, this.authPromise = void 0, this.skipReconnection = !1, this.connectionPromise = new Promise((r, n) => {
      t != null && t.timeout && (e = setTimeout(() => {
        var i;
        n("connection timed out"), this.connectionPromise = void 0, this.skipReconnection = !0, (i = this.onclose) == null || i.call(this), this.handleHardClose("relay connection timed out");
      }, t.timeout)), t != null && t.abort && (t.abort.onabort = n);
      try {
        this.ws = new this._WebSocket(this.url);
      } catch (i) {
        clearTimeout(e), n(i);
        return;
      }
      this.ws.onopen = () => {
        this.reconnectTimeoutHandle && (clearTimeout(this.reconnectTimeoutHandle), this.reconnectTimeoutHandle = void 0), clearTimeout(e), this._connected = !0;
        const i = this.reconnectAttempts > 0;
        this.reconnectAttempts = 0;
        for (const o of this.openSubs.values()) {
          if (o.eosed = !1, i)
            for (let c = 0; c < o.filters.length; c++)
              o.lastEmitted && (o.filters[c].since = o.lastEmitted + 1);
          o.fire();
        }
        this.enablePing && (this.pingIntervalHandle = setInterval(() => this.pingpong(), this.pingFrequency)), r();
      }, this.ws.onerror = () => {
        var i;
        clearTimeout(e), n("connection failed"), this.connectionPromise = void 0, this.skipReconnection = !0, (i = this.onclose) == null || i.call(this), this.handleHardClose("relay connection failed");
      }, this.ws.onclose = (i) => {
        clearTimeout(e), n(i.message || "websocket closed"), this.handleHardClose("relay connection closed");
      }, this.ws.onmessage = this._onmessage.bind(this);
    }), this.connectionPromise);
  }
  waitForPingPong() {
    return new Promise((t) => {
      this.ws.once("pong", () => t(!0)), this.ws.ping();
    });
  }
  waitForDummyReq() {
    return new Promise((t, e) => {
      if (!this.connectionPromise)
        return e(new Error(`no connection to ${this.url}, can't ping`));
      try {
        const r = this.subscribe(
          [{ ids: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], limit: 0 }],
          {
            label: "<forced-ping>",
            oneose: () => {
              t(!0), r.close();
            },
            onclose() {
              t(!0);
            },
            eoseTimeout: this.pingTimeout + 1e3
          }
        );
      } catch (r) {
        e(r);
      }
    });
  }
  async pingpong() {
    var t, e, r;
    ((t = this.ws) == null ? void 0 : t.readyState) === 1 && (await Promise.any([
      this.ws && this.ws.ping && this.ws.once ? this.waitForPingPong() : this.waitForDummyReq(),
      new Promise((i) => setTimeout(() => i(!1), this.pingTimeout))
    ]) || ((e = this.ws) == null ? void 0 : e.readyState) === this._WebSocket.OPEN && ((r = this.ws) == null || r.close()));
  }
  async send(t) {
    if (!this.connectionPromise)
      throw new Zt(t, this.url);
    this.connectionPromise.then(() => {
      var e;
      (e = this.ws) == null || e.send(t);
    });
  }
  async auth(t) {
    const e = this.challenge;
    if (!e)
      throw new Error("can't perform auth, no challenge was received");
    return this.authPromise ? this.authPromise : (this.authPromise = new Promise(async (r, n) => {
      try {
        let i = await t(er(this.url, e)), o = setTimeout(() => {
          let c = this.openEventPublishes.get(i.id);
          c && (c.reject(new Error("auth timed out")), this.openEventPublishes.delete(i.id));
        }, this.publishTimeout);
        this.openEventPublishes.set(i.id, { resolve: r, reject: n, timeout: o }), this.send('["AUTH",' + JSON.stringify(i) + "]");
      } catch (i) {
        console.warn("subscribe auth function failed:", i);
      }
    }), this.authPromise);
  }
  async publish(t) {
    this.idleSince = void 0, this.ongoingOperations++;
    const e = new Promise((r, n) => {
      const i = setTimeout(() => {
        const o = this.openEventPublishes.get(t.id);
        o && (o.reject(new Error("publish timed out")), this.openEventPublishes.delete(t.id));
      }, this.publishTimeout);
      this.openEventPublishes.set(t.id, { resolve: r, reject: n, timeout: i });
    });
    return this.send('["EVENT",' + JSON.stringify(t) + "]"), this.ongoingOperations--, this.ongoingOperations === 0 && (this.idleSince = Date.now()), e;
  }
  async count(t, e) {
    this.serial++;
    const r = (e == null ? void 0 : e.id) || "count:" + this.serial, n = new Promise((i, o) => {
      this.openCountRequests.set(r, { resolve: i, reject: o });
    });
    return this.send('["COUNT","' + r + '",' + JSON.stringify(t).substring(1)), n;
  }
  subscribe(t, e) {
    e.label !== "<forced-ping>" && (this.idleSince = void 0, this.ongoingOperations++);
    const r = this.prepareSubscription(t, e);
    return r.fire(), e.abort && (e.abort.onabort = () => r.close(String(e.abort.reason || "<aborted>"))), r;
  }
  prepareSubscription(t, e) {
    this.serial++;
    const r = e.id || (e.label ? e.label + ":" : "sub:") + this.serial, n = new tr(this, r, t, e);
    return this.openSubs.set(r, n), n;
  }
  close() {
    var t, e, r;
    this.skipReconnection = !0, this.reconnectTimeoutHandle && (clearTimeout(this.reconnectTimeoutHandle), this.reconnectTimeoutHandle = void 0), this.pingIntervalHandle && (clearInterval(this.pingIntervalHandle), this.pingIntervalHandle = void 0), this.closeAllSubscriptions("relay connection closed by us"), this._connected = !1, this.idleSince = void 0, (t = this.onclose) == null || t.call(this), ((e = this.ws) == null ? void 0 : e.readyState) === this._WebSocket.OPEN && ((r = this.ws) == null || r.close());
  }
  _onmessage(t) {
    var n, i, o, c;
    const e = t.data;
    if (!e)
      return;
    const r = Qn(e);
    if (r) {
      const s = this.openSubs.get(r);
      if (!s)
        return;
      const a = Jn(e, "id"), u = (n = s.alreadyHaveEvent) == null ? void 0 : n.call(s, a);
      if ((i = s.receivedEvent) == null || i.call(s, this, a), u)
        return;
    }
    try {
      let s = JSON.parse(e);
      switch (s[0]) {
        case "EVENT": {
          const a = this.openSubs.get(s[1]), u = s[2];
          this.verifyEvent(u) && Xn(a.filters, u) ? a.onevent(u) : (o = a.oninvalidevent) == null || o.call(a, u), (!a.lastEmitted || a.lastEmitted < u.created_at) && (a.lastEmitted = u.created_at);
          return;
        }
        case "COUNT": {
          const a = s[1], u = s[2], b = this.openCountRequests.get(a);
          b && (b.resolve(u.count), this.openCountRequests.delete(a));
          return;
        }
        case "EOSE": {
          const a = this.openSubs.get(s[1]);
          if (!a)
            return;
          a.receivedEose();
          return;
        }
        case "OK": {
          const a = s[1], u = s[2], b = s[3], l = this.openEventPublishes.get(a);
          l && (clearTimeout(l.timeout), u ? l.resolve(b) : l.reject(new Error(b)), this.openEventPublishes.delete(a));
          return;
        }
        case "CLOSED": {
          const a = s[1], u = this.openSubs.get(a);
          if (!u)
            return;
          u.closed = !0, u.close(s[2]);
          return;
        }
        case "NOTICE": {
          this.onnotice(s[1]);
          return;
        }
        case "AUTH": {
          this.challenge = s[1], this.onauth && this.auth(this.onauth);
          return;
        }
        default: {
          const a = this.openSubs.get(s[1]);
          (c = a == null ? void 0 : a.oncustom) == null || c.call(a, s);
          return;
        }
      }
    } catch (s) {
      try {
        const [a, u, b] = JSON.parse(e);
        console.warn(`[nostr] relay ${this.url} error processing message:`, s, b);
      } catch {
        console.warn(`[nostr] relay ${this.url} error processing message:`, s);
      }
      return;
    }
  }
}, tr = class {
  constructor(t, e, r, n) {
    f(this, "relay");
    f(this, "id");
    f(this, "lastEmitted");
    f(this, "closed", !1);
    f(this, "eosed", !1);
    f(this, "filters");
    f(this, "alreadyHaveEvent");
    f(this, "receivedEvent");
    f(this, "onevent");
    f(this, "oninvalidevent");
    f(this, "oneose");
    f(this, "onclose");
    f(this, "oncustom");
    f(this, "eoseTimeout");
    f(this, "eoseTimeoutHandle");
    if (r.length === 0)
      throw new Error("subscription can't be created with zero filters");
    this.relay = t, this.filters = r, this.id = e, this.alreadyHaveEvent = n.alreadyHaveEvent, this.receivedEvent = n.receivedEvent, this.eoseTimeout = n.eoseTimeout || t.baseEoseTimeout, this.oneose = n.oneose, this.onclose = n.onclose, this.oninvalidevent = n.oninvalidevent, this.onevent = n.onevent || ((i) => {
      console.warn(
        `onevent() callback not defined for subscription '${this.id}' in relay ${this.relay.url}. event received:`,
        i
      );
    });
  }
  fire() {
    this.relay.send('["REQ","' + this.id + '",' + JSON.stringify(this.filters).substring(1)), this.eoseTimeoutHandle = setTimeout(this.receivedEose.bind(this), this.eoseTimeout);
  }
  receivedEose() {
    var t;
    this.eosed || (clearTimeout(this.eoseTimeoutHandle), this.eosed = !0, (t = this.oneose) == null || t.call(this));
  }
  close(t = "closed by caller") {
    var e;
    if (!this.closed && this.relay.connected) {
      try {
        this.relay.send('["CLOSE",' + JSON.stringify(this.id) + "]");
      } catch (r) {
        if (!(r instanceof Zt)) throw r;
      }
      this.closed = !0;
    }
    this.relay.openSubs.delete(this.id), this.relay.ongoingOperations--, this.relay.ongoingOperations === 0 && (this.relay.idleSince = Date.now()), (e = this.onclose) == null || e.call(this, t);
  }
}, nr = (t) => (t[te] = !0, !0), rr = class {
  constructor(t) {
    f(this, "relays", /* @__PURE__ */ new Map());
    f(this, "seenOn", /* @__PURE__ */ new Map());
    f(this, "trackRelays", !1);
    f(this, "verifyEvent");
    f(this, "enablePing");
    f(this, "enableReconnect");
    f(this, "automaticallyAuth");
    f(this, "trustedRelayURLs", /* @__PURE__ */ new Set());
    f(this, "onRelayConnectionFailure");
    f(this, "onRelayConnectionSuccess");
    f(this, "allowConnectingToRelay");
    f(this, "maxWaitForConnection");
    f(this, "_WebSocket");
    this.verifyEvent = t.verifyEvent, this._WebSocket = t.websocketImplementation, this.enablePing = t.enablePing, this.enableReconnect = t.enableReconnect || !1, this.automaticallyAuth = t.automaticallyAuth, this.onRelayConnectionFailure = t.onRelayConnectionFailure, this.onRelayConnectionSuccess = t.onRelayConnectionSuccess, this.allowConnectingToRelay = t.allowConnectingToRelay, this.maxWaitForConnection = t.maxWaitForConnection || 3e3;
  }
  async ensureRelay(t, e) {
    t = fe(t);
    let r = this.relays.get(t);
    if (r || (r = new Dt(t, {
      verifyEvent: this.trustedRelayURLs.has(t) ? nr : this.verifyEvent,
      websocketImplementation: this._WebSocket,
      enablePing: this.enablePing,
      enableReconnect: this.enableReconnect
    }), r.onclose = () => {
      this.relays.delete(t);
    }, this.relays.set(t, r)), this.automaticallyAuth) {
      const n = this.automaticallyAuth(t);
      n && (r.onauth = n);
    }
    try {
      await r.connect({
        timeout: e == null ? void 0 : e.connectionTimeout,
        abort: e == null ? void 0 : e.abort
      });
    } catch (n) {
      throw this.relays.delete(t), n;
    }
    return r;
  }
  close(t) {
    t.map(fe).forEach((e) => {
      var r;
      (r = this.relays.get(e)) == null || r.close(), this.relays.delete(e);
    });
  }
  subscribe(t, e, r) {
    const n = [], i = [];
    for (let o = 0; o < t.length; o++) {
      const c = fe(t[o]);
      n.find((s) => s.url === c) || i.indexOf(c) === -1 && (i.push(c), n.push({ url: c, filter: e }));
    }
    return this.subscribeMap(n, r);
  }
  subscribeMany(t, e, r) {
    return this.subscribe(t, e, r);
  }
  subscribeMap(t, e) {
    const r = /* @__PURE__ */ new Map();
    for (const h of t) {
      const { url: g, filter: w } = h;
      r.has(g) || r.set(g, []), r.get(g).push(w);
    }
    const n = Array.from(r.entries()).map(([h, g]) => ({ url: h, filters: g }));
    this.trackRelays && (e.receivedEvent = (h, g) => {
      let w = this.seenOn.get(g);
      w || (w = /* @__PURE__ */ new Set(), this.seenOn.set(g, w)), w.add(h);
    });
    const i = /* @__PURE__ */ new Set(), o = [], c = [];
    let s = (h) => {
      var g;
      c[h] || (c[h] = !0, c.filter((w) => w).length === n.length && ((g = e.oneose) == null || g.call(e), s = () => {
      }));
    };
    const a = [];
    let u = (h, g) => {
      var w;
      a[h] || (s(h), a[h] = g, a.filter((p) => p).length === n.length && ((w = e.onclose) == null || w.call(e, a), u = () => {
      }));
    };
    const b = (h) => {
      var w;
      if ((w = e.alreadyHaveEvent) != null && w.call(e, h))
        return !0;
      const g = i.has(h);
      return i.add(h), g;
    }, l = Promise.all(
      n.map(async ({ url: h, filters: g }, w) => {
        var q, F, D;
        if (((q = this.allowConnectingToRelay) == null ? void 0 : q.call(this, h, ["read", g])) === !1) {
          u(w, "connection skipped by allowConnectingToRelay");
          return;
        }
        let p;
        try {
          p = await this.ensureRelay(h, {
            connectionTimeout: this.maxWaitForConnection < (e.maxWait || 0) ? Math.max(e.maxWait * 0.8, e.maxWait - 1e3) : this.maxWaitForConnection,
            abort: e.abort
          });
        } catch (U) {
          (F = this.onRelayConnectionFailure) == null || F.call(this, h), u(w, (U == null ? void 0 : U.message) || String(U));
          return;
        }
        (D = this.onRelayConnectionSuccess) == null || D.call(this, h);
        let _ = p.subscribe(g, {
          ...e,
          oneose: () => s(w),
          onclose: (U) => {
            U.startsWith("auth-required: ") && e.onauth ? p.auth(e.onauth).then(() => {
              p.subscribe(g, {
                ...e,
                oneose: () => s(w),
                onclose: (X) => {
                  u(w, X);
                },
                alreadyHaveEvent: b,
                eoseTimeout: e.maxWait,
                abort: e.abort
              });
            }).catch((X) => {
              u(w, `auth was required and attempted, but failed with: ${X}`);
            }) : u(w, U);
          },
          alreadyHaveEvent: b,
          eoseTimeout: e.maxWait,
          abort: e.abort
        });
        o.push(_);
      })
    );
    return {
      async close(h) {
        await l, o.forEach((g) => {
          g.close(h);
        });
      }
    };
  }
  subscribeEose(t, e, r) {
    let n;
    return n = this.subscribe(t, e, {
      ...r,
      oneose() {
        var o;
        const i = "closed automatically on eose";
        n ? n.close(i) : (o = r.onclose) == null || o.call(r, t.map((c) => i));
      }
    }), n;
  }
  subscribeManyEose(t, e, r) {
    return this.subscribeEose(t, e, r);
  }
  async querySync(t, e, r) {
    return new Promise(async (n) => {
      const i = [];
      this.subscribeEose(t, e, {
        ...r,
        onevent(o) {
          i.push(o);
        },
        onclose(o) {
          n(i);
        }
      });
    });
  }
  async get(t, e, r) {
    e.limit = 1;
    const n = await this.querySync(t, e, r);
    return n.sort((i, o) => o.created_at - i.created_at), n[0] || null;
  }
  publish(t, e, r) {
    return t.map(fe).map(async (n, i, o) => {
      var s, a;
      if (o.indexOf(n) !== i)
        return Promise.reject("duplicate url");
      if (((s = this.allowConnectingToRelay) == null ? void 0 : s.call(this, n, ["write", e])) === !1)
        return Promise.reject("connection skipped by allowConnectingToRelay");
      let c;
      try {
        c = await this.ensureRelay(n, {
          connectionTimeout: this.maxWaitForConnection < ((r == null ? void 0 : r.maxWait) || 0) ? Math.max(r.maxWait * 0.8, r.maxWait - 1e3) : this.maxWaitForConnection,
          abort: r == null ? void 0 : r.abort
        });
      } catch (u) {
        return (a = this.onRelayConnectionFailure) == null || a.call(this, n), "connection failure: " + String(u);
      }
      return c.publish(e).catch(async (u) => {
        if (u instanceof Error && u.message.startsWith("auth-required: ") && (r != null && r.onauth))
          return await c.auth(r.onauth), c.publish(e);
        throw u;
      }).then((u) => {
        if (this.trackRelays) {
          let b = this.seenOn.get(e.id);
          b || (b = /* @__PURE__ */ new Set(), this.seenOn.set(e.id, b)), b.add(c);
        }
        return u;
      });
    });
  }
  listConnectionStatus() {
    const t = /* @__PURE__ */ new Map();
    return this.relays.forEach((e, r) => t.set(r, e.connected)), t;
  }
  destroy() {
    this.relays.forEach((t) => t.close()), this.relays = /* @__PURE__ */ new Map();
  }
  pruneIdleRelays(t = 1e4) {
    const e = [];
    for (const [r, n] of this.relays)
      n.idleSince && Date.now() - n.idleSince >= t && (this.relays.delete(r), e.push(r), n.close());
    return e;
  }
}, Wt;
try {
  Wt = WebSocket;
} catch {
}
var Or = class extends rr {
  constructor(t) {
    super({ verifyEvent: jn, websocketImplementation: Wt, maxWaitForConnection: 3e3, ...t });
  }
}, oe = Symbol("verified"), ir = (t) => t instanceof Object;
function or(t) {
  if (!ir(t) || typeof t.kind != "number" || typeof t.content != "string" || typeof t.created_at != "number" || typeof t.pubkey != "string" || !t.pubkey.match(/^[a-f0-9]{64}$/) || !Array.isArray(t.tags))
    return !1;
  for (let e = 0; e < t.tags.length; e++) {
    let r = t.tags[e];
    if (!Array.isArray(r))
      return !1;
    for (let n = 0; n < r.length; n++)
      if (typeof r[n] != "string")
        return !1;
  }
  return !0;
}
new TextDecoder("utf-8");
var sr = new TextEncoder(), cr = class {
  generateSecretKey() {
    return j.utils.randomSecretKey();
  }
  getPublicKey(t) {
    return k(j.getPublicKey(t));
  }
  finalizeEvent(t, e) {
    const r = t;
    return r.pubkey = k(j.getPublicKey(e)), r.id = He(r), r.sig = k(j.sign(N(He(r)), e)), r[oe] = !0, r;
  }
  verifyEvent(t) {
    if (typeof t[oe] == "boolean")
      return t[oe];
    try {
      const e = He(t);
      if (e !== t.id)
        return t[oe] = !1, !1;
      const r = j.verify(N(t.sig), N(e), N(t.pubkey));
      return t[oe] = r, r;
    } catch {
      return t[oe] = !1, !1;
    }
  }
};
function ar(t) {
  if (!or(t))
    throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([0, t.pubkey, t.created_at, t.kind, t.tags, t.content]);
}
function He(t) {
  let e = pe(sr.encode(ar(t)));
  return k(e);
}
var _e = new cr();
_e.generateSecretKey;
_e.getPublicKey;
_e.finalizeEvent;
var Tr = _e.verifyEvent;
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function Mt(t) {
  return t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array";
}
function zt(t, e) {
  return Array.isArray(e) ? e.length === 0 ? !0 : t ? e.every((r) => typeof r == "string") : e.every((r) => Number.isSafeInteger(r)) : !1;
}
function ur(t) {
  if (typeof t != "function")
    throw new Error("function expected");
  return !0;
}
function be(t, e) {
  if (typeof e != "string")
    throw new Error(`${t}: string expected`);
  return !0;
}
function Yt(t) {
  if (!Number.isSafeInteger(t))
    throw new Error(`invalid integer: ${t}`);
}
function Me(t) {
  if (!Array.isArray(t))
    throw new Error("array expected");
}
function Kt(t, e) {
  if (!zt(!0, e))
    throw new Error(`${t}: array of strings expected`);
}
function jt(t, e) {
  if (!zt(!1, e))
    throw new Error(`${t}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function lr(...t) {
  const e = (o) => o, r = (o, c) => (s) => o(c(s)), n = t.map((o) => o.encode).reduceRight(r, e), i = t.map((o) => o.decode).reduce(r, e);
  return { encode: n, decode: i };
}
// @__NO_SIDE_EFFECTS__
function fr(t) {
  const e = typeof t == "string" ? t.split("") : t, r = e.length;
  Kt("alphabet", e);
  const n = new Map(e.map((i, o) => [i, o]));
  return {
    encode: (i) => (Me(i), i.map((o) => {
      if (!Number.isSafeInteger(o) || o < 0 || o >= r)
        throw new Error(`alphabet.encode: digit index outside alphabet "${o}". Allowed: ${t}`);
      return e[o];
    })),
    decode: (i) => (Me(i), i.map((o) => {
      be("alphabet.decode", o);
      const c = n.get(o);
      if (c === void 0)
        throw new Error(`Unknown letter: "${o}". Allowed: ${t}`);
      return c;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function dr(t = "") {
  return be("join", t), {
    encode: (e) => (Kt("join.decode", e), e.join(t)),
    decode: (e) => (be("join.decode", e), e.split(t))
  };
}
const Ft = (t, e) => e === 0 ? t : Ft(e, t % e), Re = /* @__NO_SIDE_EFFECTS__ */ (t, e) => t + (e - Ft(t, e)), me = /* @__PURE__ */ (() => {
  let t = [];
  for (let e = 0; e < 40; e++)
    t.push(2 ** e);
  return t;
})();
function ze(t, e, r, n) {
  if (Me(t), e <= 0 || e > 32)
    throw new Error(`convertRadix2: wrong from=${e}`);
  if (r <= 0 || r > 32)
    throw new Error(`convertRadix2: wrong to=${r}`);
  if (/* @__PURE__ */ Re(e, r) > 32)
    throw new Error(`convertRadix2: carry overflow from=${e} to=${r} carryBits=${/* @__PURE__ */ Re(e, r)}`);
  let i = 0, o = 0;
  const c = me[e], s = me[r] - 1, a = [];
  for (const u of t) {
    if (Yt(u), u >= c)
      throw new Error(`convertRadix2: invalid data word=${u} from=${e}`);
    if (i = i << e | u, o + e > 32)
      throw new Error(`convertRadix2: carry overflow pos=${o} from=${e}`);
    for (o += e; o >= r; o -= r)
      a.push((i >> o - r & s) >>> 0);
    const b = me[o];
    if (b === void 0)
      throw new Error("invalid carry");
    i &= b - 1;
  }
  if (i = i << r - o & s, !n && o >= e)
    throw new Error("Excess padding");
  if (!n && i > 0)
    throw new Error(`Non-zero padding: ${i}`);
  return n && o > 0 && a.push(i >>> 0), a;
}
// @__NO_SIDE_EFFECTS__
function hr(t, e = !1) {
  if (Yt(t), t <= 0 || t > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ Re(8, t) > 32 || /* @__PURE__ */ Re(t, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (r) => {
      if (!Mt(r))
        throw new Error("radix2.encode input should be Uint8Array");
      return ze(Array.from(r), 8, t, !e);
    },
    decode: (r) => (jt("radix2.decode", r), Uint8Array.from(ze(r, t, 8, e)))
  };
}
function yt(t) {
  return ur(t), function(...e) {
    try {
      return t.apply(null, e);
    } catch {
    }
  };
}
const Ye = /* @__PURE__ */ lr(/* @__PURE__ */ fr("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /* @__PURE__ */ dr("")), Et = [996825010, 642813549, 513874426, 1027748829, 705979059];
function ue(t) {
  const e = t >> 25;
  let r = (t & 33554431) << 5;
  for (let n = 0; n < Et.length; n++)
    (e >> n & 1) === 1 && (r ^= Et[n]);
  return r;
}
function mt(t, e, r = 1) {
  const n = t.length;
  let i = 1;
  for (let o = 0; o < n; o++) {
    const c = t.charCodeAt(o);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${t})`);
    i = ue(i) ^ c >> 5;
  }
  i = ue(i);
  for (let o = 0; o < n; o++)
    i = ue(i) ^ t.charCodeAt(o) & 31;
  for (let o of e)
    i = ue(i) ^ o;
  for (let o = 0; o < 6; o++)
    i = ue(i);
  return i ^= r, Ye.encode(ze([i % me[30]], 30, 5, !1));
}
// @__NO_SIDE_EFFECTS__
function br(t) {
  const e = t === "bech32" ? 1 : 734539939, r = /* @__PURE__ */ hr(5), n = r.decode, i = r.encode, o = yt(n);
  function c(l, h, g = 90) {
    be("bech32.encode prefix", l), Mt(h) && (h = Array.from(h)), jt("bech32.encode", h);
    const w = l.length;
    if (w === 0)
      throw new TypeError(`Invalid prefix length ${w}`);
    const p = w + 7 + h.length;
    if (g !== !1 && p > g)
      throw new TypeError(`Length ${p} exceeds limit ${g}`);
    const _ = l.toLowerCase(), q = mt(_, h, e);
    return `${_}1${Ye.encode(h)}${q}`;
  }
  function s(l, h = 90) {
    be("bech32.decode input", l);
    const g = l.length;
    if (g < 8 || h !== !1 && g > h)
      throw new TypeError(`invalid string length: ${g} (${l}). Expected (8..${h})`);
    const w = l.toLowerCase();
    if (l !== w && l !== l.toUpperCase())
      throw new Error("String must be lowercase or uppercase");
    const p = w.lastIndexOf("1");
    if (p === 0 || p === -1)
      throw new Error('Letter "1" must be present between prefix and data only');
    const _ = w.slice(0, p), q = w.slice(p + 1);
    if (q.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const F = Ye.decode(q).slice(0, -6), D = mt(_, F, e);
    if (!q.endsWith(D))
      throw new Error(`Invalid checksum in ${l}: expected "${D}"`);
    return { prefix: _, words: F };
  }
  const a = yt(s);
  function u(l) {
    const { prefix: h, words: g } = s(l, !1);
    return { prefix: h, words: g, bytes: n(g) };
  }
  function b(l, h) {
    return c(l, i(h));
  }
  return {
    encode: c,
    decode: s,
    encodeFromBytes: b,
    decodeToBytes: u,
    decodeUnsafe: a,
    fromWords: n,
    fromWordsUnsafe: o,
    toWords: i
  };
}
const Be = /* @__PURE__ */ br("bech32");
var ye = new TextDecoder("utf-8"), Ae = new TextEncoder(), gr = {
  isNProfile: (t) => /^nprofile1[a-z\d]+$/.test(t || ""),
  isNEvent: (t) => /^nevent1[a-z\d]+$/.test(t || ""),
  isNAddr: (t) => /^naddr1[a-z\d]+$/.test(t || ""),
  isNSec: (t) => /^nsec1[a-z\d]{58}$/.test(t || ""),
  isNPub: (t) => /^npub1[a-z\d]{58}$/.test(t || ""),
  isNote: (t) => /^note1[a-z\d]+$/.test(t || ""),
  isNcryptsec: (t) => /^ncryptsec1[a-z\d]+$/.test(t || "")
}, et = 5e3, wr = /[\x21-\x7E]{1,83}1[023456789acdefghjklmnpqrstuvwxyz]{6,}/;
function yr(t) {
  const e = new Uint8Array(4);
  return e[0] = t >> 24 & 255, e[1] = t >> 16 & 255, e[2] = t >> 8 & 255, e[3] = t & 255, e;
}
function Er(t) {
  try {
    return t.startsWith("nostr:") && (t = t.substring(6)), Gt(t);
  } catch {
    return { type: "invalid", data: null };
  }
}
function Gt(t) {
  var i, o, c, s, a, u, b;
  let { prefix: e, words: r } = Be.decode(t, et), n = new Uint8Array(Be.fromWords(r));
  switch (e) {
    case "nprofile": {
      let l = Ue(n);
      if (!((i = l[0]) != null && i[0]))
        throw new Error("missing TLV 0 for nprofile");
      if (l[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      return {
        type: "nprofile",
        data: {
          pubkey: k(l[0][0]),
          relays: l[1] ? l[1].map((h) => ye.decode(h)) : []
        }
      };
    }
    case "nevent": {
      let l = Ue(n);
      if (!((o = l[0]) != null && o[0]))
        throw new Error("missing TLV 0 for nevent");
      if (l[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      if (l[2] && l[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (l[3] && l[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "nevent",
        data: {
          id: k(l[0][0]),
          relays: l[1] ? l[1].map((h) => ye.decode(h)) : [],
          author: (c = l[2]) != null && c[0] ? k(l[2][0]) : void 0,
          kind: (s = l[3]) != null && s[0] ? parseInt(k(l[3][0]), 16) : void 0
        }
      };
    }
    case "naddr": {
      let l = Ue(n);
      if (!((a = l[0]) != null && a[0]))
        throw new Error("missing TLV 0 for naddr");
      if (!((u = l[2]) != null && u[0]))
        throw new Error("missing TLV 2 for naddr");
      if (l[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (!((b = l[3]) != null && b[0]))
        throw new Error("missing TLV 3 for naddr");
      if (l[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "naddr",
        data: {
          identifier: ye.decode(l[0][0]),
          pubkey: k(l[2][0]),
          kind: parseInt(k(l[3][0]), 16),
          relays: l[1] ? l[1].map((h) => ye.decode(h)) : []
        }
      };
    }
    case "nsec":
      return { type: e, data: n };
    case "npub":
    case "note":
      return { type: e, data: k(n) };
    default:
      throw new Error(`unknown prefix ${e}`);
  }
}
function Ue(t) {
  let e = {}, r = t;
  for (; r.length > 0; ) {
    let n = r[0], i = r[1], o = r.slice(2, 2 + i);
    if (r = r.slice(2 + i), o.length < i)
      throw new Error(`not enough data to read on TLV ${n}`);
    e[n] = e[n] || [], e[n].push(o);
  }
  return e;
}
function mr(t) {
  return ke("nsec", t);
}
function pr(t) {
  return ke("npub", N(t));
}
function xr(t) {
  return ke("note", N(t));
}
function $e(t, e) {
  let r = Be.toWords(e);
  return Be.encode(t, r, et);
}
function ke(t, e) {
  return $e(t, e);
}
function vr(t) {
  let e = tt({
    0: [N(t.pubkey)],
    1: (t.relays || []).map((r) => Ae.encode(r))
  });
  return $e("nprofile", e);
}
function Sr(t) {
  let e;
  t.kind !== void 0 && (e = yr(t.kind));
  let r = tt({
    0: [N(t.id)],
    1: (t.relays || []).map((n) => Ae.encode(n)),
    2: t.author ? [N(t.author)] : [],
    3: e ? [new Uint8Array(e)] : []
  });
  return $e("nevent", r);
}
function Rr(t) {
  let e = new ArrayBuffer(4);
  new DataView(e).setUint32(0, t.kind, !1);
  let r = tt({
    0: [Ae.encode(t.identifier)],
    1: (t.relays || []).map((n) => Ae.encode(n)),
    2: [N(t.pubkey)],
    3: [new Uint8Array(e)]
  });
  return $e("naddr", r);
}
function tt(t) {
  let e = [];
  return Object.entries(t).reverse().forEach(([r, n]) => {
    n.forEach((i) => {
      let o = new Uint8Array(i.length + 2);
      o.set([parseInt(r)], 0), o.set([i.length], 1), o.set(i, 2), e.push(o);
    });
  }), he(...e);
}
const Ir = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  BECH32_REGEX: wr,
  Bech32MaxSize: et,
  NostrTypeGuard: gr,
  decode: Gt,
  decodeNostrURI: Er,
  encodeBytes: ke,
  naddrEncode: Rr,
  neventEncode: Sr,
  noteEncode: xr,
  nprofileEncode: vr,
  npubEncode: pr,
  nsecEncode: mr
}, Symbol.toStringTag, { value: "Module" }));
export {
  Or as SimplePool,
  Ir as nip19,
  Tr as verifyEvent
};
