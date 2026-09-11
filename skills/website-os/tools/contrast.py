#!/usr/bin/env python3
"""Measure WCAG contrast. Paste the real number into the palette panel — never eyeball it.

    python3 contrast.py '#586B84' '#F7F4ED'
    python3 contrast.py --palette '#F7F4ED' '#1E2D4D' '#586B84' '#E2643C'
"""
import sys


def lum(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def verdict(r):
    """AA thresholds: 4.5 for body text, 3.0 for large (>=24px, or >=18.66px bold)."""
    return (f"{r:5.2f}:1   body-AA {'PASS' if r >= 4.5 else 'FAIL'}"
            f"   large-AA {'PASS' if r >= 3 else 'FAIL'}")


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)

    if args[0] == '--palette':
        bg, fgs = args[1], args[2:]
        print(f'against {bg}\n')
        for f in sorted(fgs, key=lambda x: -ratio(x, bg)):
            print(f'  {f}  {verdict(ratio(f, bg))}')
    else:
        fg, bg = args[0], args[1]
        print(f'{fg} on {bg}   {verdict(ratio(fg, bg))}')
