# Quick LaTeX

Quick LaTeX renders a formula with the TeX installation on your Mac and copies
the result to the clipboard as a tightly cropped, transparent PNG. Rendering is
fully local and does not send the formula to an external service.

## Requirements

- Raycast for macOS
- BasicTeX or MacTeX
- `latex` and `dvipng` under `/Library/TeX/texbin`

Check the TeX installation:

```sh
/Library/TeX/texbin/latex --version
/Library/TeX/texbin/kpsewhich amsmath.sty
/Library/TeX/texbin/kpsewhich amssymb.sty
```

BasicTeX does not install `dvipng` by default. Install it with:

```sh
sudo /Library/TeX/texbin/tlmgr install dvipng
```

If TeX Live asks you to update its package manager first, run:

```sh
sudo /Library/TeX/texbin/tlmgr update --self
sudo /Library/TeX/texbin/tlmgr install dvipng
```

Then verify it:

```sh
/Library/TeX/texbin/dvipng --version
```

## Development

Install the JavaScript dependencies and start the Raycast development
extension:

```sh
npm install
npm run dev
```

You can then assign a Raycast hotkey to **Quick LaTeX**. Type a formula, wait
for the local preview, and press Enter to copy the transparent PNG. Paste it
into Noteful or another app with Command-V.

## Rendering defaults

- Display-math input (`\[ ... \]`)
- `amsmath` and `amssymb`
- Transparent background
- Black clipboard output
- 512 DPI

Color, size, and SVG/PDF export are not part of the initial local renderer.

## Custom preamble

Open Raycast Settings, select **LaTeX to Image**, and enter additional LaTeX
commands in **Custom Preamble**. The setting is appended after the built-in
`amsmath` and `amssymb` packages and applies to both previews and copied PNGs.

Raycast provides this setting as a single-line field. LaTeX commands can be
separated with spaces, for example:

```tex
\usepackage{amsmath,amsfonts, amssymb, amsthm, mathtools, theorem, bm, physics}
```

Package imports and definitions such as `\newcommand` and
`\DeclareMathOperator` are supported. Do not include `\documentclass`,
`\begin{document}`, or `\end{document}` because the extension supplies the
document structure.

To check whether a package is installed, pass its `.sty` file to `kpsewhich`:

```sh
/Library/TeX/texbin/kpsewhich physics.sty
```

An empty result means the package is not available in the active TeX
installation. Invalid commands, missing packages, and package option conflicts
are reported as LaTeX rendering errors.
