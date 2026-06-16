# Hangul equation script reference (`append_equation`)

The `append_equation` op inserts a real Hangul Word Processor equation object
(the same equation engine the desktop editor uses), built from an equation
**script** string passed as `script`. Any token below renders the same as if
typed in the equation editor.

```bash
echo '{
  "path": "out.hwp",
  "operations": [
    {"type": "setup_document", "page_size": "a4"},
    {"type": "append_paragraph", "text": "근의 공식:"},
    {"type": "append_equation", "script": "x = {-b +- sqrt{b^2 -4ac}} over {2a}"},
    {"type": "append_equation", "script": "int _0 ^1 x^2 dx = 1 over 3", "size": 1200}
  ]
}' | node scripts/create.js
```

- `script` (required) — the equation script (tokens below). **Case-sensitive.**
- `size` (optional) — font size in HWP units/100 (1000 ≈ 10pt, default 1000).
- `color` (optional) — `#RRGGBB`, default `#000000`. · `align` (optional).
- Works for both `.hwp` and `.hwpx` output (from-scratch build). On an existing
  large `.hwp`, this routes through the rhwp serializer like `append_image`, so
  prefer it when building a new document (the equation object itself is fine —
  it's the big-form round-trip that's the constraint, not the equation).

## Basic rules
- Superscript `a^b` · subscript `a_b` · group with braces `{ }` (e.g. `e^{-x}`)
- Space `~` (wider `~~`) · column align `&` · row break `#`
- Example: `x = {-b +- sqrt{b^2 -4ac}} over {2a}` → quadratic formula

## Structure templates

| Kind | Tokens | Notes |
|---|---|---|
| Sub/superscript | `^{ }` up · `_{ }` down · `{ } LSUP { }` upper-left · `{ } LSUB { }` lower-left · `UNDEROVER { } _{ } ^{ }` over+under | |
| Fraction | `{ } over { }` | |
| Root | `sqrt { }` · `root n of x` (nth root) | |
| Big operators | `sum` `PROD` `COPROD` `INTER` `UNION` `BIGSQCAP` `BIGSQCUP` `BIGOPLUS` `BIGOMINUS` `BIGOTIMES` `BIGODIV` `BIGODOT` `BIGVEE` `BIGWEDGE` `BIGUPLUS` — all take `_{ } ^{ }` limits | e.g. `sum from {i=1} to n` or `sum _{i=1} ^n` |
| Integral | `int` `dint`(double) `tint`(triple) `oint`(contour) `odint` `otint` — `_{ } ^{ } { }` | |
| Limit | `lim _{ } { }` · `lim _{x -> 0}` · `lim _{ ->inf}` · `Lim` | `rightarrow` also works as → |
| Auto-size brackets | `LEFT ( RIGHT )` · `LEFT [ RIGHT ]` · `LEFT { RIGHT }` · `LEFT < RIGHT >` · `LEFT \| RIGHT \|` · `LEFT DLINE RIGHT DLINE` · `LCEIL RCEIL` · `LFLOOR RFLOOR` · `OVERBRACE { } { }` · `UNDERBRACE { } { }` | lowercase `left( right)` also works |
| Matrix | `matrix { & # & }`(no bracket) · `pmatrix`(parens) · `bmatrix`(brackets) · `dmatrix`(determinant bars) | `&`=column, `#`=row |
| Cases | `cases { & # & }` | |
| Vertical stack | `pile { # }` | |
| Long division | `LONGDIV { } { } { }` | |
| LCM/GCD ladder | `LADDER { & & # & & }` | |
| Relation (text over/under arrow) | `REL <arrow> { } { }` · `BUILDREL <arrow> { } { }` | arrows = `LRARROW` `lrarrow` `RARROW` `rarrow` `LARROW` `larrow` `EXARROW` |
| Accents | `vec { }` `dyad { }` `acute { }` `grave { }` `dot { }` `ddot { }` `under { }` `bar { }` `hat { }` `check { }` `arch { }` `tilde { }` `box { }` | e.g. `vec{a}` → →a |

## Symbols

### Greek lowercase
`alpha` `beta` `gamma` `delta` `epsilon` `zeta` `eta` `theta` `iota` `kappa` `lambda` `mu` `nu` `xi` `omicron` `pi` `rho` `sigma` `tau` `upsilon` `phi` `chi` `psi` `omega`

### Greek uppercase
`ALPHA` `BETA` `GAMMA` `DELTA` `EPSILON` `ZETA` `ETA` `THETA` `IOTA` `KAPPA` `LAMBDA` `MU` `NU` `XI` `OMICRON` `PI` `RHO` `SIGMA` `TAU` `UPSILON` `PHI` `CHI` `PSI` `OMEGA`

### Greek / special letters
`ALEPH`(ℵ) `hbar`(ℏ) `imath` `jmath` `ohm` `LITER`(ℓ) `WP`(℘) `IMAG`(ℑ) `ANGSTROM`(Å) `vartheta` `varpi` `varsigma` `varupsilon` `varphi` `varepsilon`

### Set / sum symbols
`SMALLSUM` `SMALLPROD` `SMCOPROD` `SMALLINTER`(∩) `CUP`(∪) `SQCAP` `SQCUP` `OPLUS`(⊕) `OMINUS`(⊖) `OTIMES`(⊗) `ODIV` `ODOT`(⊙) `LOR`(∨) `WEDGE`(∧) `SUBSET`(⊂) `SUPERSET`(⊃) `SUBSETEQ`(⊆) `SUPSETEQ`(⊇) `IN`(∈) `OWNS`(∋) `NOTIN`(∉) `LEQ`(≤) `GEQ`(≥) `SQSUBSET` `SQSUPSET` `SQSUBSETEQ` `SQSUPSETEQ` `<<` `>>` `<<<` `>>>` `PREC`(≺) `SUCC`(≻) `UPLUS`

### Operators / logic
`+-`(±) `-+`(∓) `TIMES`(×) `DIVIDE`(÷) `CIRC`(∘) `BULLET`(•) `DEG`(°) `AST`(∗) `STAR`(⋆) `BIGCIRC`(○) `EMPTYSET`(∅) `THEREFORE`(∴) `BECAUSE`(∵) `IDENTICAL`(≡) `EXIST`(∃) `!=`(≠) `DOTEQ`(≐) `image` `REIMAGE` `SIM`(∼) `APPROX`(≈) `SIMEQ`(≃) `CONG`(≅) `==` `ASYMP`(≍) `ISO` `DIAMOND`(◇) `DSUM` `FORALL`(∀) `prime`(′) `PARTIAL`(∂) `INF`(∞, lowercase `inf` also works) `LNOT`(¬) `PROPTO`(∝) `XOR` `NABLA`(∇) `DAGGER`(†) `DDAGGER`(‡)

### Arrows
`larrow`(←) `rarrow`(→, `rightarrow` also works) `uparrow`(↑) `downarrow`(↓) `LARROW`(⇐) `RARROW`(⇒) `UPARROW`(⇑) `DOWNARROW`(⇓) `udarrow`(↕) `lrarrow`(↔, `<=>` also ⇔) `UDARROW`(⇕) `LRARROW`(⇔) `NWARROW`(↖) `SEARROW`(↘) `NEARROW`(↗) `SWARROW`(↙) `HOOKLEFT`(↩) `HOOKRIGHT`(↪) `MAPSTO`(↦) `vert`(|) `DLINE`(‖)

### Misc symbols
`CDOTS`(⋯) `LDOTS`(…) `VDOTS`(⋮) `DDOTS`(⋱) `TRIANGLE`(△) `NABLA`(∇) `ANGLE`(∠) `MSANGLE` `SANGLE` `RTANGLE` `VDASH`(⊢) `DASHV`(⊣) `BOT`(⊥) `TOP`(⊤) `MODELS`(⊨) `LAPLACE` `CENTIGRADE`(℃) `FAHRENHEIT`(℉) `LSLANT` `RSLANT` `ATT` `HUND` `THOU` `WELL`(#) `BASE` `BENZENE`

## Examples
```
x = {-b +- sqrt{b^2 -4ac}} over {2a}            → quadratic formula
sum from {i=1} to n i^2 = {n(n+1)(2n+1)} over 6 → sigma sum
int _0 ^inf e^{-x} dx = GAMMA (1)               → integral · gamma
lim _{x rightarrow 0} {sin x} over x = 1        → limit
A = left [ matrix{1 & 0 # 0 & 1} right ]        → matrix
root 3 of x ~ oint _0 ^1 x dx                   → cube root · contour integral
vec{a} cdot bar{b} ~ THEREFORE ~ alpha != OMEGA → accents · symbols
```

> Verified: a 21-case sweep covering every structure template + symbol group
> above embeds as a native equation object and renders. The `script` string is
> embedded verbatim into the equation object, so the renderer treats it exactly
> as the editor would.
