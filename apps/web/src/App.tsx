import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

type PointerAction = { type: "pointer"; slide: number; x: number; y: number };
type HighlightAction = {
  type: "highlight";
  slide: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
type ClearAction = { type: "clear"; slide?: number };
type GoToSlideAction = { type: "go_to_slide"; slide: number };
type SlideAction = PointerAction | HighlightAction | ClearAction | GoToSlideAction;

type DrawAction = PointerAction | HighlightAction;

type NormalizedPoint = {
  x: number;
  y: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildDrawActionsForSlide(actions: SlideAction[], slide: number): DrawAction[] {
  const draw: DrawAction[] = [];

  actions.forEach((action) => {
    if (action.type === "go_to_slide") {
      return;
    }

    if (action.type === "clear") {
      if (action.slide === undefined || action.slide === slide) {
        draw.length = 0;
      }
      return;
    }

    if (action.slide === slide) {
      draw.push(action);
    }
  });

  return draw;
}

function toNormalizedPoint(
  event: React.PointerEvent<HTMLCanvasElement>,
  rect: DOMRect
): NormalizedPoint {
  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height)
  };
}

function toPixel(normalized: NormalizedPoint, width: number, height: number): { x: number; y: number } {
  return {
    x: normalized.x * width,
    y: normalized.y * height
  };
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [actions, setActions] = useState<SlideAction[]>([]);
  const [dragStart, setDragStart] = useState<NormalizedPoint | null>(null);
  const [dragCurrent, setDragCurrent] = useState<NormalizedPoint | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState<string>(`[
  { "type": "go_to_slide", "slide": 2 },
  { "type": "highlight", "slide": 2, "x": 0.18, "y": 0.3, "w": 0.5, "h": 0.12 },
  { "type": "pointer", "slide": 2, "x": 0.7, "y": 0.4 }
]`);
  const [commandErrors, setCommandErrors] = useState<string[]>([]);

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [viewerWidth, setViewerWidth] = useState<number>(900);

  const drawActions = useMemo(
    () => buildDrawActionsForSlide(actions, currentPage),
    [actions, currentPage]
  );

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setViewerWidth(element.clientWidth);
    });

    observer.observe(element);
    setViewerWidth(element.clientWidth);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || pageSize.width === 0 || pageSize.height === 0) {
      return;
    }

    canvas.width = pageSize.width;
    canvas.height = pageSize.height;
    canvas.style.width = `${pageSize.width}px`;
    canvas.style.height = `${pageSize.height}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);

    drawActions.forEach((action) => {
      if (action.type === "pointer") {
        const pixel = toPixel({ x: action.x, y: action.y }, canvas.width, canvas.height);
        context.beginPath();
        context.fillStyle = "#ff2d55";
        context.arc(pixel.x, pixel.y, 8, 0, Math.PI * 2);
        context.fill();
        return;
      }

      const start = toPixel({ x: action.x, y: action.y }, canvas.width, canvas.height);
      context.fillStyle = "rgba(255, 215, 0, 0.35)";
      context.strokeStyle = "rgba(194, 142, 0, 0.9)";
      context.lineWidth = 2;
      context.fillRect(start.x, start.y, action.w * canvas.width, action.h * canvas.height);
      context.strokeRect(start.x, start.y, action.w * canvas.width, action.h * canvas.height);
    });

    if (dragStart && dragCurrent) {
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const w = Math.abs(dragCurrent.x - dragStart.x);
      const h = Math.abs(dragCurrent.y - dragStart.y);

      const start = toPixel({ x, y }, canvas.width, canvas.height);
      context.fillStyle = "rgba(0, 150, 255, 0.2)";
      context.strokeStyle = "rgba(0, 120, 200, 0.9)";
      context.lineWidth = 2;
      context.fillRect(start.x, start.y, w * canvas.width, h * canvas.height);
      context.strokeRect(start.x, start.y, w * canvas.width, h * canvas.height);
    }
  }, [drawActions, dragStart, dragCurrent, pageSize]);

  function onDocumentLoadSuccess(result: { numPages: number }) {
    setPdfError(null);
    setActions([]);
    setCommandErrors([]);
    setNumPages(result.numPages);
    setCurrentPage(1);
  }

  function isValidSlide(slide: unknown): slide is number {
    return typeof slide === "number" && Number.isInteger(slide) && slide >= 1 && slide <= numPages;
  }

  function isNormalized(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  }

  function validateAction(raw: unknown): { valid: true; action: SlideAction } | { valid: false; error: string } {
    if (!raw || typeof raw !== "object") {
      return { valid: false, error: "Action is not an object." };
    }

    const action = raw as Record<string, unknown>;
    if (typeof action.type !== "string") {
      return { valid: false, error: "Action is missing a string 'type'." };
    }

    if (action.type === "go_to_slide") {
      if (!isValidSlide(action.slide)) {
        return { valid: false, error: "go_to_slide requires a valid slide number." };
      }
      return { valid: true, action: { type: "go_to_slide", slide: action.slide } };
    }

    if (action.type === "clear") {
      if (action.slide === undefined) {
        return { valid: true, action: { type: "clear" } };
      }
      if (!isValidSlide(action.slide)) {
        return { valid: false, error: "clear.slide must be a valid slide number when provided." };
      }
      return { valid: true, action: { type: "clear", slide: action.slide } };
    }

    if (action.type === "pointer") {
      if (!isValidSlide(action.slide)) {
        return { valid: false, error: "pointer.slide must be a valid slide number." };
      }
      if (!isNormalized(action.x) || !isNormalized(action.y)) {
        return { valid: false, error: "pointer x/y must be numbers between 0 and 1." };
      }
      return {
        valid: true,
        action: { type: "pointer", slide: action.slide, x: action.x, y: action.y }
      };
    }

    if (action.type === "highlight") {
      if (!isValidSlide(action.slide)) {
        return { valid: false, error: "highlight.slide must be a valid slide number." };
      }
      if (!isNormalized(action.x) || !isNormalized(action.y)) {
        return { valid: false, error: "highlight x/y must be numbers between 0 and 1." };
      }
      if (typeof action.w !== "number" || typeof action.h !== "number" || action.w <= 0 || action.h <= 0) {
        return { valid: false, error: "highlight w/h must be positive numbers." };
      }
      if (action.x + action.w > 1 || action.y + action.h > 1) {
        return { valid: false, error: "highlight rectangle must stay inside normalized bounds." };
      }
      return {
        valid: true,
        action: {
          type: "highlight",
          slide: action.slide,
          x: action.x,
          y: action.y,
          w: action.w,
          h: action.h
        }
      };
    }

    return { valid: false, error: `Unknown action type '${action.type}'.` };
  }

  function runAction(
    action: SlideAction,
    state: { actions: SlideAction[]; page: number }
  ): { actions: SlideAction[]; page: number } {
    if (action.type === "go_to_slide") {
      return { actions: state.actions, page: action.slide };
    }

    if (action.type === "clear") {
      if (action.slide === undefined) {
        return { actions: [...state.actions, { type: "clear" }], page: state.page };
      }
      return { actions: [...state.actions, action], page: action.slide };
    }

    return { actions: [...state.actions, action], page: action.slide };
  }

  function runActions(batch: SlideAction[]) {
    const errors: string[] = [];
    let next = { actions, page: currentPage };

    batch.forEach((action, index) => {
      const validated = validateAction(action);
      if (!validated.valid) {
        const message = `Action ${index + 1}: ${validated.error}`;
        errors.push(message);
        console.error(message, action);
        return;
      }
      next = runAction(validated.action, next);
    });

    if (errors.length > 0) {
      setCommandErrors(errors);
    } else {
      setCommandErrors([]);
    }

    setActions(next.actions);
    setCurrentPage(next.page);
  }

  function runActionsFromInput() {
    if (!file || numPages === 0) {
      setCommandErrors(["Load a PDF before running actions."]);
      return;
    }

    try {
      const parsed = JSON.parse(commandInput) as unknown;
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      runActions(batch as SlideAction[]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
      setCommandErrors([`Invalid JSON: ${message}`]);
    }
  }

  function addCenterPointer() {
    runActions([{ type: "pointer", slide: currentPage, x: 0.5, y: 0.5 }]);
  }

  function clearCurrentOverlay() {
    runActions([{ type: "clear", slide: currentPage }]);
    setDragStart(null);
    setDragCurrent(null);
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const normalized = toNormalizedPoint(event, rect);
    setDragStart(normalized);
    setDragCurrent(normalized);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    setDragCurrent(toNormalizedPoint(event, rect));
  }

  function endDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart || !dragCurrent) {
      return;
    }

    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);

    if (w > 0.002 && h > 0.002) {
      runActions([{ type: "highlight", slide: currentPage, x, y, w, h }]);
    }

    setDragStart(null);
    setDragCurrent(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <label className="upload-control">
          Upload PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              setPdfError(null);
              setNumPages(0);
              setCurrentPage(1);
              setActions([]);
              setCommandErrors([]);
              setFile(event.target.files?.[0] ?? null);
            }}
          />
        </label>
        <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
          Prev
        </button>
        <button
          onClick={() => setCurrentPage((p) => Math.min(numPages || 1, p + 1))}
          disabled={currentPage >= numPages}
        >
          Next
        </button>
        <span className="page-indicator">Page {numPages ? currentPage : 0} / {numPages}</span>
        <button onClick={addCenterPointer} disabled={!file}>
          Place Pointer
        </button>
        <button onClick={clearCurrentOverlay} disabled={!file}>
          Clear Overlay
        </button>
      </header>

      <main className="main-layout">
        <section className="viewer-pane" ref={viewerRef}>
          {file ? (
            <div className="page-stage" style={{ width: `${Math.max(320, viewerWidth)}px` }}>
              <Document
                file={file}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={(error) => setPdfError(`Could not load PDF: ${error.message}`)}
                onSourceError={(error) => setPdfError(`Could not read file: ${error.message}`)}
              >
                <Page
                  pageNumber={currentPage}
                  width={Math.max(320, viewerWidth)}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  onRenderError={(error) => setPdfError(`Could not render page: ${error.message}`)}
                  onRenderSuccess={() => {
                    const canvas = viewerRef.current?.querySelector(".react-pdf__Page__canvas");
                    if (canvas) {
                      setPageSize({
                        width: Math.floor(canvas.clientWidth),
                        height: Math.floor(canvas.clientHeight)
                      });
                    }
                  }}
                />
              </Document>

              <canvas
                ref={overlayRef}
                className="overlay-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
          ) : (
            <div className="empty-state">Upload a PDF to start.</div>
          )}
          {pdfError ? <p style={{ color: "#b91c1c", fontWeight: 600 }}>{pdfError}</p> : null}
        </section>

        <aside className="debug-pane">
          <h2>Command Runner</h2>
          <p className="panel-label">Paste JSON action(s):</p>
          <textarea
            className="command-input"
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            spellCheck={false}
          />
          <button className="run-actions-btn" onClick={runActionsFromInput} disabled={!file || numPages === 0}>
            Run Actions
          </button>
          {commandErrors.length > 0 ? (
            <div className="command-errors">
              {commandErrors.map((error, index) => (
                <p key={`${error}-${index}`}>{error}</p>
              ))}
            </div>
          ) : null}

          <h2>Actions State</h2>
          <pre>{JSON.stringify(actions, null, 2)}</pre>
        </aside>
      </main>
    </div>
  );
}
