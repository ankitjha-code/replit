import { type ReactElement, type ReactNode } from 'react';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { EmptyState, type EmptyStateProps } from '../EmptyState/EmptyState.js';
import { RowActions, type RowAction } from '../RowActions/RowActions.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { cx } from '../internal/cx.js';
import './Table.css';

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  width?: string;
  align?: 'start' | 'end';
  mono?: boolean;
  cell: (row: Row) => ReactNode;
}

export interface TablePagination {
  count: number;
  total?: number;
  onMore?: () => void;
  loadingMore?: boolean;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption: string;
  empty: Omit<EmptyStateProps, 'size'>;
  loading?: boolean;
  placeholderRows?: number;
  error?: string;
  onRetry?: () => void;
  rowActions?: (row: Row) => RowAction[];
  rowName?: (row: Row) => string;
  pagination?: TablePagination;
  density?: 'dense' | 'regular';
  className?: string;
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  loading = false,
  placeholderRows = 3,
  error,
  onRetry,
  rowActions,
  rowName,
  pagination,
  density = 'regular',
  className,
}: TableProps<Row>): ReactElement {
  const columnCount = columns.length + (rowActions ? 1 : 0);

  if (!loading && !error && rows.length === 0) {
    return (
      <div className={cx('ui-table-wrap', className)}>
        <EmptyState size="panel" {...empty} />
      </div>
    );
  }

  return (
    <div className={cx('ui-table-wrap', className)} aria-busy={loading || undefined}>
      <table className={cx('ui-table', `ui-table--${density}`)}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx('ui-table__th', column.align === 'end' && 'ui-table__cell--end')}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
            {rowActions ? (
              <th scope="col" className="ui-table__th ui-table__cell--end">
                <span className="visually-hidden">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr>
              <td colSpan={columnCount} className="ui-table__state">
                <Callout
                  tone="danger"
                  title={error}
                  action={
                    onRetry ? (
                      <Button size="sm" onClick={onRetry}>
                        Retry
                      </Button>
                    ) : undefined
                  }
                />
              </td>
            </tr>
          ) : loading ? (
            Array.from({ length: placeholderRows }, (_, index) => (
              <tr key={`placeholder-${index}`} className="ui-table__row">
                {columns.map((column) => (
                  <td key={column.key} className="ui-table__td">
                    <Skeleton height={12} width={column.mono ? '80%' : '60%'} />
                  </td>
                ))}
                {rowActions ? <td className="ui-table__td" /> : null}
              </tr>
            ))
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="ui-table__row">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      'ui-table__td',
                      column.mono && 'ui-table__cell--mono',
                      column.align === 'end' && 'ui-table__cell--end',
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
                {rowActions ? (
                  <td className="ui-table__td ui-table__cell--end ui-table__cell--actions">
                    <RowActions
                      items={rowActions(row)}
                      objectName={rowName ? rowName(row) : rowKey(row)}
                    />
                  </td>
                ) : null}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {pagination && !loading && !error ? (
        <div className="ui-table__pagination">
          <span className="ui-table__count">
            {pagination.total !== undefined
              ? `${pagination.count} of ${pagination.total}`
              : `${pagination.count} shown`}
          </span>
          {pagination.onMore &&
          (pagination.total === undefined || pagination.count < pagination.total) ? (
            <Button size="sm" onClick={pagination.onMore} loading={pagination.loadingMore ?? false}>
              Show more
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
