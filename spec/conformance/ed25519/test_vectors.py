#!/usr/bin/env python3
"""PROTOCOL §2.4 Keys: a conforming verifier gives exactly EXPECTED on the 12 ed25519-speccheck vectors
(novifinancial/ed25519-speccheck, Chalkias et al. 2020). This is the BoringSSL / OpenSSL / CryptoKit / Go / PyCA
row. Small-order keys are refused separately, once, at key registration (is_small_order)."""
import json, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
EXPECTED = "VVVVxxxxxxxV"
# the 8 small-order points' canonical encodings (y-coordinates), from the speccheck / Bernstein list
SMALL_ORDER = {bytes.fromhex(h) for h in [
 "0100000000000000000000000000000000000000000000000000000000000000",
 "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
 "0000000000000000000000000000000000000000000000000000000000000080",
 "0000000000000000000000000000000000000000000000000000000000000000",
 "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
 "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
 "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
 "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"]}
P = 2**255 - 19
def is_noncanonical(pub: bytes) -> bool:
    return int.from_bytes(pub, "little") & ((1 << 255) - 1) >= P
def _y(pub): return pub[:31] + bytes([pub[31] & 0x7f])
SMALL_ORDER_Y = {_y(s) for s in SMALL_ORDER}
def refuse_at_registration(pub: bytes) -> bool:
    # small order in ANY sign-bit encoding (catches x = "-0", cases 10/11), or y >= p
    return len(pub) != 32 or _y(pub) in SMALL_ORDER_Y or is_noncanonical(pub)
def verify(pub, sig, msg):
    try: Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg); return True
    except Exception: return False
cases = json.load(open(os.path.join(os.path.dirname(__file__), "speccheck-cases.json")))
got = "".join("V" if verify(*(bytes.fromhex(c[k]) for k in ("pub_key", "signature", "message"))) else "x" for c in cases)
print("verify row", got, "PASS" if got == EXPECTED else "FAIL (expected %s)" % EXPECTED)
reg = "".join("R" if refuse_at_registration(bytes.fromhex(c["pub_key"])) else "." for c in cases)
REG_EXPECTED = "RR........RR"
print("registration refuses", reg, "PASS" if reg == REG_EXPECTED else "FAIL (expected %s)" % REG_EXPECTED)
ok = "".join("V" if (got[i] == "V" and reg[i] == ".") else "x" for i in range(12))
print("effective (registered key AND verifies):", ok)
passed = (got == EXPECTED) + (reg == REG_EXPECTED)
print("%d/2 passed" % passed)
sys.exit(0 if passed == 2 else 1)
