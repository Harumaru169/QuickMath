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

type ForegroundColor = "Black" | "White";

const FOREGROUND_SPECS: Record<ForegroundColor, string> = {
  Black: "rgb 0 0 0",
  White: "rgb 1 1 1",
};

export interface RenderOptions {
  renderer: "latex" | "typst";
  preamble: string;
}

export class FormulaRenderError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "FormulaRenderError";
  }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function getPreviewImage(searchText: string, options: RenderOptions, signal?: AbortSignal) {
  const [light, dark] = await renderImages(searchText, options, ["Black", "White"], signal);
  return { source: { light: toPngDataUrl(light), dark: toPngDataUrl(dark) } };
}

export async function renderFormula(searchText: string, options: RenderOptions) {
  const [image] = await renderImages(searchText, options, ["Black"]);
  return image;
}

async function renderImages(
  searchText: string,
  { renderer, preamble }: RenderOptions,
  colors: ForegroundColor[],
  signal?: AbortSignal
) {
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quick-math-"));

  try {
    const images: Buffer[] = [];
    if (renderer === "typst") {
      for (const color of colors) {
        images.push(await compileTypst(searchText, workDirectory, color, signal));
      }
      return images;
    }

    await checkDependencies();
    const latex = searchText.trim() === "" ? "LaTeX" : searchText;
    const dviPath = await compileToDvi(latex, preamble, workDirectory, signal);
    for (const color of colors) {
      images.push(await convertDviToPng(dviPath, workDirectory, color, signal));
    }
    return images;
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

async function checkDependencies() {
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
    ["-D", "512", "-T", "tight", "-bg", "Transparent", "-fg", FOREGROUND_SPECS[foreground], "-o", outputPath, dviPath],
    workDirectory,
    signal,
    "dvipng could not create the PNG image."
  );

  return fs.readFile(outputPath);
}

async function compileTypst(
  searchText: string,
  workDirectory: string,
  foreground: ForegroundColor,
  signal?: AbortSignal
) {
  const formula = searchText.trim() || "x";
  const source = `#set page(width: auto, height: auto, margin: 1pt, fill: none)
#set text(size: 12pt, fill: ${foreground.toLowerCase()})
$ ${formula} $
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
          resolve();
          return;
        }

        if (error.name === "AbortError") {
          reject(error);
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("\n");
        if (executable === "typst" && error.code === "ENOENT") {
          reject(new FormulaRenderError("Typst was not found. Make sure typst is on Raycast's PATH."));
          return;
        }

        const detail = executable === "typst" ? output.trim() : extractLatexError(output);
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
  const customPreamble = normalizePreamble(preamble);
  const customPreambleBlock = customPreamble === "" ? "" : `${customPreamble}\n`;

  return `\\documentclass[12pt]{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
${customPreambleBlock}\\pagestyle{empty}
\\begin{document}
\\thispagestyle{empty}
\\[
${latex}
\\]
\\end{document}
`;
}

function normalizePreamble(preamble: string) {
  return preamble.replace(/\r\n?/g, "\n").trim();
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
