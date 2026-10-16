import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PDFDocumentProxy } from "./pdfEngine";
import { usePdfDocument } from "./usePdfDocument";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./pdfEngine", () => ({ loadPdfDocument: load }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function pdf() {
  const destroy = vi.fn(async () => {});
  return {
    document: {
      numPages: 3,
      destroy,
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }),
    } as unknown as PDFDocumentProxy,
    destroy,
  };
}

describe("PDF resource generations (Synara lifecycle cases)", () => {
  let renderer: ReactTestRenderer | undefined;
  const observations: (PDFDocumentProxy | null)[] = [];
  function Harness({ url }: { url: string }) {
    const state = usePdfDocument(url);
    useLayoutEffect(() => {
      observations.push(state.document);
    });
    return (
      <output>
        {state.status}:{state.error}
      </output>
    );
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    observations.length = 0;
    load.mockReset();
  });
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount());
    vi.unstubAllGlobals();
  });
  it("never publishes the destroyed first A during A -> B -> A", async () => {
    const a = pdf();
    const secondA = pdf();
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const request = deferred<Response>();
        requests.push(request);
        return request.promise;
      }),
    );
    load.mockResolvedValueOnce(a.document).mockResolvedValueOnce(secondA.document);
    await act(async () => {
      renderer = create(<Harness url="/a.pdf" />);
    });
    await act(async () => {
      requests[0]!.resolve(new Response(new Uint8Array([1])));
    });
    expect(observations.at(-1)).toBe(a.document);
    await act(() => renderer!.update(<Harness url="/b.pdf" />));
    expect(a.destroy).toHaveBeenCalledOnce();
    const beforeReturn = observations.length;
    await act(() => renderer!.update(<Harness url="/a.pdf" />));
    expect(observations.slice(beforeReturn)).not.toContain(a.document);
    expect(observations.at(-1)).toBeNull();
    await act(async () => {
      requests[2]!.resolve(new Response(new Uint8Array([2])));
    });
    expect(observations.at(-1)).toBe(secondA.document);
    await act(async () => {
      requests[1]!.resolve(new Response(new Uint8Array([3])));
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(observations.at(-1)).toBe(secondA.document);
  });
  it("destroys an obsolete document that finishes loading after switching", async () => {
    const old = pdf();
    const pending = deferred<PDFDocumentProxy>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    load.mockReturnValueOnce(pending.promise).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      renderer = create(<Harness url="/a.pdf" />);
    });
    await act(() => renderer!.update(<Harness url="/b.pdf" />));
    await act(async () => {
      pending.resolve(old.document);
    });
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(observations).not.toContain(old.document);
  });
  it("propagates read failures and loads fresh bytes for a renewed URL", async () => {
    const good = pdf();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchMock);
    load.mockResolvedValue(good.document);
    await act(async () => {
      renderer = create(<Harness url="https://remote.test/expired" />);
    });
    expect(renderer!.root.findByType("output").children.join("")).toContain(
      "error:Failed to load PDF (403)",
    );
    await act(async () => {
      renderer!.update(<Harness url="https://remote.test/renewed" />);
    });
    expect(observations.at(-1)).toBe(good.document);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://remote.test/expired",
      "https://remote.test/renewed",
    ]);
    expect(fetchMock.mock.calls[0]![1].cache).toBe("no-store");
  });
  it("destroys a document if reading the first page fails", async () => {
    const broken = pdf();
    broken.document.getPage = vi.fn().mockRejectedValue(new Error("Broken page"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    load.mockResolvedValue(broken.document);
    await act(async () => {
      renderer = create(<Harness url="/broken.pdf" />);
    });
    expect(broken.destroy).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("output").children.join("")).toContain("Broken page");
  });
});
