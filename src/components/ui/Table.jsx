import { useMemo, useState } from 'react';

/**
 * Sortable data table.
 * columns: [{ key, label, render?(row), sort?(row) => comparable, num?, width?, className? }]
 * `rowKey(row)` must be stable. `onRowClick(row)` makes rows clickable.
 * `groupBy(row)` (optional) renders group header rows in sorted order.
 */
export default function Table({ columns, rows, rowKey, onRowClick, selectedKey, initialSort, empty, groupBy, maxHeight, dense }) {
  const [sort, setSort] = useState(initialSort || null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sort || ((r) => r[col.key]);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [rows, sort, columns]);

  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const r of sorted) {
      const g = groupBy(r);
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(r);
    }
    return [...m.entries()];
  }, [sorted, groupBy]);

  const toggle = (key) =>
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));

  const renderRow = (r) => {
    const k = rowKey(r);
    return (
      <tr
        key={k}
        className={onRowClick ? 'clickable' : undefined}
        aria-selected={selectedKey === k}
        onClick={onRowClick ? () => onRowClick(r) : undefined}
        onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}
        tabIndex={onRowClick ? 0 : undefined}
      >
        {columns.map((c) => (
          <td key={c.key} className={`${c.num ? 'num' : ''} ${c.className || ''}`} style={dense ? { paddingTop: 5, paddingBottom: 5 } : undefined}>
            {c.render ? c.render(r) : r[c.key]}
          </td>
        ))}
      </tr>
    );
  };

  if (!rows.length) return empty || null;
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = c.sortable !== false;
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={`${sortable ? 'sortable' : ''} ${c.num ? 'num' : ''}`}
                  style={c.width ? { width: c.width } : undefined}
                  onClick={sortable ? () => toggle(c.key) : undefined}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  scope="col"
                >
                  {c.label}
                  {active && <span className="sort-ind">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups
            ? groups.map(([g, rs]) => [
                <tr key={`g:${g}`} className="group-row">
                  <td colSpan={columns.length}>
                    {g} <span className="faint">· {rs.length}</span>
                  </td>
                </tr>,
                ...rs.map(renderRow),
              ])
            : sorted.map(renderRow)}
        </tbody>
      </table>
    </div>
  );
}
