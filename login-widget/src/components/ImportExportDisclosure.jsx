/**
 * ImportExportDisclosure — normally-closed <details> block at the top
 * of the event composer.
 *
 * Frames file upload / paste-id-to-load / export-current-draft as
 * optional power-user actions instead of a row of unexplained controls.
 * Originally ported from mynostr; visually re-skinned to the LB
 * cream-card design system via the `.lb-disclosure` / `.lb-btn-*`
 * classes defined in styles.css.
 *
 * Props are minimal and presentational — all state (errors, loading,
 * input value) is owned by the parent composer.
 */
import { useRef, useState } from 'react'

export default function ImportExportDisclosure({
  summaryLabel = 'Import / Export Options',   // the disclosure's clickable header
  description = 'Optional — Import/Export a draft file or load an existing event ID as a draft.',

  // Upload (optional — omit onImportFile to hide the upload button entirely)
  acceptedFileTypes,        // e.g. ".json,application/json"
  onImportFile,             // (file) => Promise<{ok, error}> | void
  importLabel = 'Upload',
  importTitle,
  importLoading = false,
  importError = '',

  // Paste id
  pasteIdValue,
  onPasteIdChange,
  onLoadId,
  pasteIdPlaceholder = 'naddr1… / nevent1…',
  loadButtonLabel = 'Load',
  loadLoading = false,
  loadError = '',

  // Export
  exportLabel = 'Export',
  onExport,
  exportDisabled = false,
  exportTitle,
  exportMenuItems,          // optional: [{ label, onClick, disabled? }, …]

  onToggle,                 // (open: boolean) => void — fires on expand/collapse
  children,                 // rendered below the controls (e.g. a copy-from list)
}) {
  const fileRef = useRef(null)
  const [exportOpen, setExportOpen] = useState(false)

  const error = importError || loadError

  const showExport = !!onExport || (exportMenuItems && exportMenuItems.length > 0)

  return (
    <details
      className="lb-disclosure"
      onToggle={(e) => onToggle?.(e.currentTarget.open)}
    >
      <summary>
        <svg
          className="lb-caret"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
        <span>{summaryLabel}</span>
      </summary>

      <div style={{ padding: '0.4rem 0.85rem 0.85rem' }} className="space-y-2">
        <p style={{ fontSize: '0.78rem', lineHeight: 1.45, color: 'var(--muted,#5a7488)', margin: 0 }}>
          {description}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Upload (only when the parent wires onImportFile) */}
          {onImportFile && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={acceptedFileTypes}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) onImportFile(f)
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={importLoading}
                title={importTitle}
                className="lb-btn lb-btn-secondary"
                style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}
              >
                {importLoading ? '…' : importLabel}
              </button>
            </>
          )}

          {/* Export — simple button or dropdown (omitted when no handler) */}
          {showExport && (exportMenuItems && exportMenuItems.length > 0 ? (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                disabled={exportDisabled}
                title={exportTitle}
                className="lb-btn lb-btn-secondary"
                style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}
              >
                {exportLabel}
                <svg style={{ width: '10px', height: '10px' }} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <path d="M2 4l4 4 4-4z" />
                </svg>
              </button>
              {exportOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setExportOpen(false)}
                  />
                  <div style={{
                    position: 'absolute', right: 0, marginTop: '0.25rem', zIndex: 20,
                    minWidth: '10rem', borderRadius: '6px',
                    border: '1px solid var(--border,#cfe2ee)', background: 'var(--white,#ffffff)',
                    boxShadow: '0 8px 24px rgba(30, 58, 95, 0.12)', padding: '0.25rem 0',
                  }}>
                    {exportMenuItems.map((item, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={item.disabled}
                        onClick={() => { setExportOpen(false); item.onClick?.() }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '0.4rem 0.85rem', fontSize: '0.82rem',
                          color: item.disabled ? 'var(--muted,#5a7488)' : 'var(--text,#0f2733)',
                          background: 'transparent', border: 'none',
                          cursor: item.disabled ? 'not-allowed' : 'pointer',
                        }}
                        onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'var(--cream,#eef6fb)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onExport}
              disabled={exportDisabled}
              title={exportTitle}
              className="lb-btn lb-btn-secondary"
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}
            >
              {exportLabel}
            </button>
          ))}

          {/* Paste id + Load — flex-grows to fill remaining space. */}
          <form
            onSubmit={(e) => { e.preventDefault(); if (onLoadId) onLoadId() }}
            className="flex items-center gap-1.5"
            style={{ flex: 1, minWidth: '12rem' }}
          >
            <input
              type="search"
              value={pasteIdValue ?? ''}
              onChange={(e) => onPasteIdChange?.(e.target.value)}
              placeholder={pasteIdPlaceholder}
              disabled={loadLoading}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              className="lb-input"
              style={{ flex: 1, minWidth: 0, padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}
            />
            <button
              type="submit"
              disabled={loadLoading || !(pasteIdValue ?? '').trim()}
              className="lb-btn lb-btn-secondary"
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}
            >
              {loadLoading ? '…' : loadButtonLabel}
            </button>
          </form>
        </div>

        {error && <div className="lb-error">{error}</div>}

        {children}
      </div>
    </details>
  )
}
