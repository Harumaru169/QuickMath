import {
  Action,
  ActionPanel,
  Image,
  LaunchProps,
  List,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  popToRoot,
  showHUD,
  showToast,
} from "@raycast/api";
import { useEffect, useState } from "react";

import { getPreviewImage, isAbortError, LatexRenderError, renderFormula } from "./api";
import { copyPngToClipboard, QuickLatexArguments, QuickLatexPreferences } from "./utils";

const PREVIEW_DEBOUNCE_MS = 500;

export default function QuickLatexCommand(props: LaunchProps<{ arguments: QuickLatexArguments }>) {
  const { preamble } = getPreferenceValues<QuickLatexPreferences>();
  const [searchText, setSearchText] = useState(props.arguments.latex ?? "");
  const [previewImage, setPreviewImage] = useState<Image.ImageLike>();
  const [previewError, setPreviewError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isCurrent = true;
    const abortController = new AbortController();
    setIsLoading(true);

    const timeout = setTimeout(() => {
      getPreviewImage(searchText, preamble, abortController.signal)
        .then((image) => {
          if (isCurrent) {
            setPreviewImage(image);
            setPreviewError(undefined);
          }
        })
        .catch((error: unknown) => {
          if (isCurrent && !isAbortError(error)) {
            setPreviewError(getErrorMessage(error));
          }
        })
        .finally(() => {
          if (isCurrent) {
            setIsLoading(false);
          }
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      isCurrent = false;
      clearTimeout(timeout);
      abortController.abort();
    };
  }, [searchText, preamble]);

  async function copyFormula() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Rendering LaTeX",
    });

    try {
      const png = await renderFormula(searchText, preamble);
      await copyPngToClipboard(png);
      toast.style = Toast.Style.Success;
      toast.title = "Copied transparent PNG";
      await popToRoot();
      await showHUD("Copied transparent PNG to clipboard.");
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not render LaTeX";
      toast.message = getErrorMessage(error);
    }
  }

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchText={searchText}
      searchBarPlaceholder="Type a LaTeX formula"
    >
      <List.EmptyView
        icon={previewImage}
        title={previewError ? "Preview not updated" : undefined}
        description={previewError}
        actions={
          <ActionPanel>
            <Action title="Copy as PNG" onAction={copyFormula} />
            <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />
          </ActionPanel>
        }
      />
    </List>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof LatexRenderError) {
    return [error.message, error.detail].filter(Boolean).join(" ");
  }

  return error instanceof Error ? error.message : "An unexpected rendering error occurred.";
}
