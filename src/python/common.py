"""Shared JSON/JavaScript string semantics. No I/O or provider authority."""

import re

WS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class DomainError(Exception):
    pass


def require(condition, code="invalid"):
    if not condition:
        raise DomainError(code)


def units(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def cut(value, start=0, end=None):
    return value.encode("utf-16-le", "surrogatepass")[
        2 * start : None if end is None else 2 * end
    ].decode("utf-16-le", "surrogatepass")


def trim(value):
    return value.strip(WS)


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def integer(value):
    return type(value) is int and abs(value) <= 9007199254740991


def plain(value, limit=500):
    return (
        cut(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", re.sub(r"<[^>]*>", "", value)), 0, limit)
        if isinstance(value, str)
        else ""
    )
