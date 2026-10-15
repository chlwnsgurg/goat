import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { PdfZoom } from "./pdfLayout";

export function PdfPageInput(props: {
  page: number;
  count: number;
  navigate: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.page));
  const commit = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= props.count) props.navigate(value);
    else setDraft(String(props.page));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
      className="w-14"
    >
      <Input
        aria-label="PDF page number"
        size="compact"
        type="number"
        min={1}
        max={props.count}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </form>
  );
}

export function PdfToolbar(props: {
  page: number;
  count: number;
  scale: number;
  navigate: (page: number) => void;
  zoom: (zoom: PdfZoom) => void;
  find: () => void;
  reload: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="PDF controls"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-2 py-1 text-xs"
    >
      <Button
        variant="ghost"
        size="xs"
        aria-label="Previous PDF page"
        disabled={props.page <= 1}
        onClick={() => props.navigate(props.page - 1)}
      >
        Prev
      </Button>
      <PdfPageInput
        key={props.page}
        page={props.page}
        count={props.count}
        navigate={props.navigate}
      />
      <span aria-label={`${props.count} pages`}>/ {props.count}</span>
      <Button
        variant="ghost"
        size="xs"
        aria-label="Next PDF page"
        disabled={props.page >= props.count}
        onClick={() => props.navigate(props.page + 1)}
      >
        Next
      </Button>
      <Button
        variant="ghost"
        size="xs"
        aria-label="Zoom out"
        disabled={props.scale <= 0.1}
        onClick={() => props.zoom(props.scale / 1.25)}
      >
        −
      </Button>
      <span>{Math.round(props.scale * 100)}%</span>
      <Button
        variant="ghost"
        size="xs"
        aria-label="Zoom in"
        disabled={props.scale >= 5}
        onClick={() => props.zoom(props.scale * 1.25)}
      >
        +
      </Button>
      <Button variant="ghost" size="xs" onClick={() => props.zoom("fit-width")}>
        Fit width
      </Button>
      <Button variant="ghost" size="xs" onClick={() => props.zoom("fit-page")}>
        Fit page
      </Button>
      <Button variant="ghost" size="xs" onClick={props.find}>
        Find
      </Button>
      <Button variant="ghost" size="xs" onClick={props.reload}>
        Reload PDF
      </Button>
    </div>
  );
}
