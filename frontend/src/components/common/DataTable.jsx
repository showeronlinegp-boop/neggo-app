import { useEffect } from 'react';
import { useTheme } from '../../theme/ThemeContext';

const STYLE_ID = 'neggo-skeleton-kf';
function injectSkeletonKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = `@keyframes neggo-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }`;
  document.head.appendChild(tag);
}

function SkeletonRow({ colCount, tokens: t }) {
  return (
    <tr>
      {Array.from({ length: colCount }).map((_, i) => (
        <td key={i} style={{ padding: '12px 16px' }}>
          <div style={{
            height: 14,
            backgroundColor: t.color.surface2,
            borderRadius: t.radius.sm,
            animation: 'neggo-pulse 1.4s ease-in-out infinite',
            width: '75%',
          }} />
        </td>
      ))}
    </tr>
  );
}

export default function DataTable({
  columns = [],
  data = [],
  loading = false,
  onRowClick,
  pagination,
  onPageChange,
}) {
  const { tokens: t } = useTheme();
  useEffect(() => { injectSkeletonKeyframes(); }, []);

  const hasPagination = pagination && onPageChange;
  const { page = 1, pageSize = 20, total = 0 } = pagination || {};
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const totalPages = Math.ceil(total / pageSize) || 1;
  const rowClickable = typeof onRowClick === 'function';

  return (
    <div>
      <div style={{
        background: t.color.surface,
        border: `1px solid ${t.color.border}`,
        borderRadius: t.radius.lg,
        boxShadow: t.shadow.card,
        overflowX: 'auto',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.base }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={{
                  padding: '12px 16px',
                  textAlign: 'left',
                  fontWeight: t.font.weight.semibold,
                  color: t.color.textMuted,
                  fontSize: t.font.size.xs,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  borderBottom: `1px solid ${t.color.border}`,
                  whiteSpace: 'nowrap',
                  background: t.color.surface2,
                  fontFamily: t.font.family,
                }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} colCount={columns.length} tokens={t} />
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{
                  padding: '48px 24px',
                  textAlign: 'center',
                  color: t.color.textFaint,
                  fontSize: t.font.size.base,
                }}>
                  No hay datos para mostrar.
                </td>
              </tr>
            ) : (
              data.map((row, rowIdx) => (
                <DataRow
                  key={row.id ?? rowIdx}
                  row={row}
                  columns={columns}
                  clickable={rowClickable}
                  onClick={rowClickable ? () => onRowClick(row) : undefined}
                  tokens={t}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasPagination && !loading && data.length > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 4px 0',
          flexWrap: 'wrap',
          gap: 8,
        }}>
          <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
            Mostrando {from}–{to} de {total}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PageBtn
              onClick={() => page > 1 && onPageChange(page - 1)}
              disabled={page <= 1}
              tokens={t}
            >
              ← Anterior
            </PageBtn>
            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, minWidth: 50, textAlign: 'center' }}>
              {page} / {totalPages}
            </span>
            <PageBtn
              onClick={() => page < totalPages && onPageChange(page + 1)}
              disabled={page >= totalPages}
              tokens={t}
            >
              Siguiente →
            </PageBtn>
          </div>
        </div>
      )}
    </div>
  );
}

function DataRow({ row, columns, clickable, onClick, tokens: t }) {
  return (
    <tr
      onClick={onClick}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = t.color.surface2; } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
      style={{
        borderTop: `1px solid ${t.color.border}`,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 100ms',
      }}
    >
      {columns.map((col) => (
        <td key={col.key} style={{
          padding: '12px 16px',
          verticalAlign: 'middle',
          color: t.color.text,
          fontFamily: t.font.family,
        }}>
          {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
        </td>
      ))}
    </tr>
  );
}

function PageBtn({ children, onClick, disabled, tokens: t }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.color.surface,
        color: disabled ? t.color.textFaint : t.color.primary,
        border: `1px solid ${disabled ? t.color.border : t.color.borderStrong}`,
        padding: '6px 14px',
        borderRadius: t.radius.sm,
        fontSize: t.font.size.sm,
        fontWeight: t.font.weight.medium,
        fontFamily: t.font.family,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}
