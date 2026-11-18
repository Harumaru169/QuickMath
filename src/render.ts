import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEX_BIN = "/Library/TeX/texbin";
const LATEX_PATH = path.join(TEX_BIN, "latex");
const DVIPNG_PATH = path.join(TEX_BIN, "dvipng");
const PROCESS_TIMEOUT_MS = 8_000;
const MAX_PROCESS_OUTPUT = 1024 * 1024;

const LATEX_COLORS = {
  black: "rgb 0 0 0",
  white: "rgb 1 1 1",
};
type ForegroundColor = keyof typeof LATEX_COLORS;

export class FormulaRenderError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "FormulaRenderError";
  }
}

export async function renderPreview(formula: string, options: Preferences, signal?: AbortSignal) {
  const [light, dark] = await renderImages(formula, options, ["black", "white"], signal);
  return { source: { light: toPngDataUrl(light), dark: toPngDataUrl(dark) } };
}

export async function renderPng(formula: string, options: Preferences) {
  const [image] = await renderImages(formula, options, ["black"]);
  return image;
}

async function renderImages(
  formula: string,
  { renderer, preamble }: Preferences,
  colors: ForegroundColor[],
  signal?: AbortSignal
) {
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quick-math-"));

  try {
    const images: Buffer[] = [];
    if (renderer === "typst") {
      for (const color of colors) {
        images.push(await compileTypst(formula, workDirectory, color, signal));
      }
      return images;
    }

    await checkLatexDependencies();
    const latex = formula.trim() ? formula : "LaTeX";
    const dviPath = await compileToDvi(latex, preamble, workDirectory, signal);
    for (const color of colors) {
      images.push(await convertDviToPng(dviPath, workDirectory, color, signal));
    }
    return images;
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

async function checkLatexDependencies() {
  await requireExecutable(
    LATEX_PATH,
    `LaTeX was not found at ${LATEX_PATH}. Install BasicTeX or MacTeX and try again.`
  );
  await requireExecutable(
    DVIPNG_PATH,
    `dvipng was not found at ${DVIPNG_PATH}. Install it with: sudo ${path.join(TEX_BIN, "tlmgr")} install dvipng`
  );
}

async function requireExecutable(executablePath: string, message: string) {
  try {
    await fs.access(executablePath, fsConstants.X_OK);
  } catch {
    throw new FormulaRenderError(message);
  }
}

async function compileToDvi(latex: string, preamble: string, workDirectory: string, signal?: AbortSignal) {
  const texPath = path.join(workDirectory, "formula.tex");
  await fs.writeFile(texPath, buildDocument(latex, preamble), "utf8");

  await runCommand(
    LATEX_PATH,
    [
      "-no-shell-escape",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      `-output-directory=${workDirectory}`,
      texPath,
    ],
    workDirectory,
    signal,
    "LaTeX could not render this formula or custom preamble."
  );

  return path.join(workDirectory, "formula.dvi");
}

async function convertDviToPng(
  dviPath: string,
  workDirectory: string,
  foreground: ForegroundColor,
  signal?: AbortSignal
) {
  const outputPath = path.join(workDirectory, "formula.png");

  await runCommand(
    DVIPNG_PATH,
    ["-D", "512", "-T", "tight", "-bg", "Transparent", "-fg", LATEX_COLORS[foreground], "-o", outputPath, dviPath],
    workDirectory,
    signal,
    "dvipng could not create the PNG image."
  );

  return fs.readFile(outputPath);
}

async function compileTypst(formula: string, workDirectory: string, foreground: ForegroundColor, signal?: AbortSignal) {
  const source = `#set page(width: auto, height: auto, margin: 1pt, fill: none)
#set text(size: 12pt, fill: ${foreground})
$ ${formula.trim() || "x"} $
`;
  await fs.writeFile(path.join(workDirectory, "formula.typ"), source, "utf8");
  await runCommand(
    "typst",
    ["compile", "--ppi", "512", "--diagnostic-format", "short", "formula.typ", "formula.png"],
    workDirectory,
    signal,
    "Typst could not render this formula."
  );
  return fs.readFile(path.join(workDirectory, "formula.png"));
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  fallbackMessage: string
) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        signal,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT,
      },
      (error, stdout, stderr) => {
        if (!error) {
          return resolve();
        }

        if (error.name === "AbortError") {
          return reject(error);
        }

        const isTypst = executable === "typst";
        if (isTypst && error.code === "ENOENT") {
          return reject(new FormulaRenderError("Typst was not found. Make sure typst is on Raycast's PATH."));
        }

        const output = [stdout, stderr].filter(Boolean).join("\n");
        const detail = isTypst ? output.trim() : extractLatexError(output);
        const message =
          "killed" in error && error.killed
            ? `Rendering timed out after ${PROCESS_TIMEOUT_MS / 1000} seconds.`
            : fallbackMessage;
        reject(new FormulaRenderError(message, detail));
      }
    );
  });
}

function buildDocument(latex: string, preamble: string) {
  const customPreamble = preamble.replace(/\r\n?/g, "\n").trim();

  return `\\documentclass[12pt]{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
${customPreamble ? `${customPreamble}\n` : ""}\\pagestyle{empty}
\\begin{document}
\\thispagestyle{empty}
\\[
${latex}
\\]
\\end{document}
`;
}

function extractLatexError(output: string) {
  const lines = output.split(/\r?\n/);
  const errorIndex = lines.findIndex((line) => line.startsWith("!") || /formula\.tex:\d+:/.test(line));

  if (errorIndex === -1) {
    return undefined;
  }

  return lines
    .slice(errorIndex, errorIndex + 3)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function toPngDataUrl(image: Buffer) {
  return `data:image/png;base64,${image.toString("base64")}`;
}
