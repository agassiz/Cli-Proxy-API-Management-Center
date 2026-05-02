import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Select } from '@/components/ui/Select';
import { IconChevronDown, IconChevronUp, IconSlidersHorizontal } from '@/components/ui/icons';
import { authFilesApi } from '@/services/api/authFiles';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { parseTimestampMs } from '@/utils/timestamp';
import {
  collectUsageDetails,
  extractLatencyMs,
  extractTotalTokens,
  formatDurationMs,
  LATENCY_SOURCE_FIELD,
  normalizeAuthIndex,
  type UsageThinking,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const MAX_RENDERED_EVENTS = 500;
const REQUEST_EVENTS_COLUMNS_STORAGE_KEY = 'usage.requestEvents.columnPreferences';

type RequestEventColumnId =
  | 'timestamp'
  | 'model'
  | 'source'
  | 'authIndex'
  | 'result'
  | 'latency'
  | 'thinking'
  | 'inputTokens'
  | 'outputTokens'
  | 'reasoningTokens'
  | 'cachedTokens'
  | 'totalTokens';

type RequestEventColumnPreferences = {
  order: RequestEventColumnId[];
  hidden: RequestEventColumnId[];
};

type RequestEventColumn = {
  id: RequestEventColumnId;
  label: string;
  headerTitle?: string;
  cell: (row: RequestEventRow) => ReactNode;
};

const REQUEST_EVENT_COLUMN_IDS: RequestEventColumnId[] = [
  'timestamp',
  'model',
  'source',
  'authIndex',
  'result',
  'latency',
  'thinking',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedTokens',
  'totalTokens',
];

type RequestEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  model: string;
  sourceKey: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  authIndex: string;
  failed: boolean;
  latencyMs: number | null;
  thinking: UsageThinking | null;
  thinkingLabel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

const isRequestEventColumnId = (value: unknown): value is RequestEventColumnId =>
  typeof value === 'string' && REQUEST_EVENT_COLUMN_IDS.includes(value as RequestEventColumnId);

const normalizeColumnPreferences = (value: unknown): RequestEventColumnPreferences => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const seen = new Set<RequestEventColumnId>();
  const order = Array.isArray(record.order)
    ? record.order.filter((id): id is RequestEventColumnId => {
        if (!isRequestEventColumnId(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    : [];

  REQUEST_EVENT_COLUMN_IDS.forEach((id) => {
    if (!seen.has(id)) {
      order.push(id);
    }
  });

  const hidden = Array.isArray(record.hidden)
    ? record.hidden.filter(isRequestEventColumnId)
    : [];

  return {
    order,
    hidden: Array.from(new Set(hidden)),
  };
};

const readColumnPreferences = (): RequestEventColumnPreferences => {
  if (typeof window === 'undefined') {
    return normalizeColumnPreferences(null);
  }

  try {
    return normalizeColumnPreferences(
      JSON.parse(window.localStorage.getItem(REQUEST_EVENTS_COLUMNS_STORAGE_KEY) || 'null')
    );
  } catch {
    return normalizeColumnPreferences(null);
  }
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const normalizeThinkingText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const formatThinkingLabel = (thinking: UsageThinking | null): string => {
  if (!thinking) return '-';

  const intensity = normalizeThinkingText(thinking.intensity);
  const level = normalizeThinkingText(thinking.level);
  const mode = normalizeThinkingText(thinking.mode);
  const budget =
    typeof thinking.budget === 'number' && Number.isFinite(thinking.budget)
      ? thinking.budget
      : null;
  const label = intensity || level || (budget !== null ? String(budget) : mode);
  const budgetLabel = budget !== null ? budget.toLocaleString() : null;

  if (!label) return '-';
  if (budgetLabel !== null && label === String(budget)) {
    return budgetLabel;
  }
  if (mode === 'budget' && budget !== null && budget > 0) {
    return `${label} (${budgetLabel})`;
  }
  if (budget === -1 && label !== 'auto') {
    return `${label} (-1)`;
  }
  return label;
};

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [authIndexFilter, setAuthIndexFilter] = useState(ALL_FILTER);
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());
  const [columnPreferences, setColumnPreferences] = useState<RequestEventColumnPreferences>(
    readColumnPreferences
  );
  const [columnConfigOpen, setColumnConfigOpen] = useState(false);
  const columnConfigRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    authFilesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return;
        const map = new Map<string, CredentialInfo>();
        files.forEach((file) => {
          const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (!key) return;
          map.set(key, {
            name: file.name || key,
            type: (file.type || file.provider || '').toString(),
          });
        });
        setAuthFileMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      REQUEST_EVENTS_COLUMNS_STORAGE_KEY,
      JSON.stringify(columnPreferences)
    );
  }, [columnPreferences]);

  useEffect(() => {
    if (!columnConfigOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && columnConfigRef.current?.contains(target)) {
        return;
      }
      setColumnConfigOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [columnConfigOpen]);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, vertexConfigs]
  );

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    const baseRows = details.map((detail, index) => {
      const timestamp = detail.timestamp;
      const timestampMs =
        typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
          ? detail.__timestampMs
          : parseTimestampMs(timestamp);
      const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
      const sourceRaw = String(detail.source ?? '').trim();
      const authIndexRaw = detail.auth_index as unknown;
      const authIndex =
        authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
          ? '-'
          : String(authIndexRaw);
      const sourceInfo = resolveSourceDisplay(sourceRaw, authIndexRaw, sourceInfoMap, authFileMap);
      const source = sourceInfo.displayName;
      const sourceKey = sourceInfo.identityKey ?? `source:${sourceRaw || source}`;
      const sourceType = sourceInfo.type;
      const model = String(detail.__modelName ?? '').trim() || '-';
      const inputTokens = Math.max(toNumber(detail.tokens?.input_tokens), 0);
      const outputTokens = Math.max(toNumber(detail.tokens?.output_tokens), 0);
      const reasoningTokens = Math.max(toNumber(detail.tokens?.reasoning_tokens), 0);
      const cachedTokens = Math.max(
        Math.max(toNumber(detail.tokens?.cached_tokens), 0),
        Math.max(toNumber(detail.tokens?.cache_tokens), 0)
      );
      const totalTokens = Math.max(
        toNumber(detail.tokens?.total_tokens),
        extractTotalTokens(detail)
      );
      const latencyMs = extractLatencyMs(detail);
      const thinking = detail.thinking ?? null;
      const thinkingLabel = formatThinkingLabel(thinking);

      return {
        id: `${timestamp}-${model}-${sourceKey}-${authIndex}-${index}`,
        timestamp,
        timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
        timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
        model,
        sourceKey,
        sourceRaw: sourceRaw || '-',
        source,
        sourceType,
        authIndex,
        failed: detail.failed === true,
        latencyMs,
        thinking,
        thinkingLabel,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
      };
    });

    const sourceLabelKeyMap = new Map<string, Set<string>>();
    baseRows.forEach((row) => {
      const keys = sourceLabelKeyMap.get(row.source) ?? new Set<string>();
      keys.add(row.sourceKey);
      sourceLabelKeyMap.set(row.source, keys);
    });

    const buildDisambiguatedSourceLabel = (row: RequestEventRow) => {
      const labelKeyCount = sourceLabelKeyMap.get(row.source)?.size ?? 0;
      if (labelKeyCount <= 1) {
        return row.source;
      }

      if (row.authIndex !== '-') {
        return `${row.source} · ${row.authIndex}`;
      }

      if (row.sourceRaw !== '-' && row.sourceRaw !== row.source) {
        return `${row.source} · ${row.sourceRaw}`;
      }

      if (row.sourceType) {
        return `${row.source} · ${row.sourceType}`;
      }

      return `${row.source} · ${row.sourceKey}`;
    };

    return baseRows
      .map((row) => ({
        ...row,
        source: buildDisambiguatedSourceLabel(row),
      }))
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [authFileMap, i18n.language, sourceInfoMap, usage]);

  const hasLatencyData = useMemo(() => rows.some((row) => row.latencyMs !== null), [rows]);
  const hiddenColumnIds = useMemo(
    () => new Set(columnPreferences.hidden),
    [columnPreferences.hidden]
  );
  const availableColumnIds = useMemo(
    () => columnPreferences.order.filter((id) => id !== 'latency' || hasLatencyData),
    [columnPreferences.order, hasLatencyData]
  );

  const columns = useMemo<Record<RequestEventColumnId, RequestEventColumn>>(
    () => ({
      timestamp: {
        id: 'timestamp',
        label: t('usage_stats.request_events_timestamp'),
        cell: (row) => (
          <td title={row.timestamp} className={styles.requestEventsTimestamp}>
            {row.timestampLabel}
          </td>
        ),
      },
      model: {
        id: 'model',
        label: t('usage_stats.model_name'),
        cell: (row) => <td className={styles.modelCell}>{row.model}</td>,
      },
      source: {
        id: 'source',
        label: t('usage_stats.request_events_source'),
        cell: (row) => (
          <td className={styles.requestEventsSourceCell} title={row.source}>
            <span>{row.source}</span>
            {row.sourceType && <span className={styles.credentialType}>{row.sourceType}</span>}
          </td>
        ),
      },
      authIndex: {
        id: 'authIndex',
        label: t('usage_stats.request_events_auth_index'),
        cell: (row) => (
          <td className={styles.requestEventsAuthIndex} title={row.authIndex}>
            {row.authIndex}
          </td>
        ),
      },
      result: {
        id: 'result',
        label: t('usage_stats.request_events_result'),
        cell: (row) => (
          <td>
            <span
              className={
                row.failed ? styles.requestEventsResultFailed : styles.requestEventsResultSuccess
              }
            >
              {row.failed ? t('stats.failure') : t('stats.success')}
            </span>
          </td>
        ),
      },
      latency: {
        id: 'latency',
        label: t('usage_stats.time'),
        headerTitle: latencyHint,
        cell: (row) => <td className={styles.durationCell}>{formatDurationMs(row.latencyMs)}</td>,
      },
      thinking: {
        id: 'thinking',
        label: t('usage_stats.thinking_intensity'),
        cell: (row) => (
          <td>
            <span
              className={
                row.thinking ? styles.requestEventsThinkingBadge : styles.requestEventsThinkingEmpty
              }
              title={
                row.thinking
                  ? [
                      row.thinking.mode
                        ? `${t('usage_stats.thinking_mode')}: ${row.thinking.mode}`
                        : '',
                      row.thinking.level
                        ? `${t('usage_stats.thinking_level')}: ${row.thinking.level}`
                        : '',
                      typeof row.thinking.budget === 'number'
                        ? `${t('usage_stats.thinking_budget')}: ${row.thinking.budget.toLocaleString()}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
            >
              {row.thinkingLabel}
            </span>
          </td>
        ),
      },
      inputTokens: {
        id: 'inputTokens',
        label: t('usage_stats.input_tokens'),
        cell: (row) => <td>{row.inputTokens.toLocaleString()}</td>,
      },
      outputTokens: {
        id: 'outputTokens',
        label: t('usage_stats.output_tokens'),
        cell: (row) => <td>{row.outputTokens.toLocaleString()}</td>,
      },
      reasoningTokens: {
        id: 'reasoningTokens',
        label: t('usage_stats.reasoning_tokens'),
        cell: (row) => <td>{row.reasoningTokens.toLocaleString()}</td>,
      },
      cachedTokens: {
        id: 'cachedTokens',
        label: t('usage_stats.cached_tokens'),
        cell: (row) => <td>{row.cachedTokens.toLocaleString()}</td>,
      },
      totalTokens: {
        id: 'totalTokens',
        label: t('usage_stats.total_tokens'),
        cell: (row) => <td>{row.totalTokens.toLocaleString()}</td>,
      },
    }),
    [latencyHint, t]
  );

  const visibleColumnIds = useMemo<RequestEventColumnId[]>(() => {
    const visible = availableColumnIds.filter((id) => !hiddenColumnIds.has(id));
    return visible.length > 0 ? visible : ['timestamp'];
  }, [availableColumnIds, hiddenColumnIds]);

  const visibleColumns = useMemo(
    () => visibleColumnIds.map((id) => columns[id]),
    [columns, visibleColumnIds]
  );
  const visibleColumnCount = visibleColumnIds.length;

  const handleToggleColumn = (columnId: RequestEventColumnId, visible: boolean) => {
    setColumnPreferences((prev) => {
      const hidden = new Set(prev.hidden);
      if (visible) {
        hidden.delete(columnId);
      } else {
        const currentVisibleCount = availableColumnIds.filter((id) => !hidden.has(id)).length;
        if (currentVisibleCount <= 1) return prev;
        hidden.add(columnId);
      }
      return { ...prev, hidden: Array.from(hidden) };
    });
  };

  const handleMoveColumn = (columnId: RequestEventColumnId, direction: -1 | 1) => {
    setColumnPreferences((prev) => {
      const available = prev.order.filter((id) => availableColumnIds.includes(id));
      const currentIndex = available.indexOf(columnId);
      const targetId = available[currentIndex + direction];
      if (currentIndex < 0 || !targetId) return prev;

      const order = [...prev.order];
      const sourceIndex = order.indexOf(columnId);
      const targetIndex = order.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      [order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]];
      return { ...prev, order };
    });
  };

  const handleResetColumns = () => {
    setColumnPreferences(normalizeColumnPreferences(null));
  };

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(() => {
    const optionMap = new Map<string, string>();
    rows.forEach((row) => {
      if (!optionMap.has(row.sourceKey)) {
        optionMap.set(row.sourceKey, row.source);
      }
    });

    return [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(optionMap.entries()).map(([value, label]) => ({
        value,
        label,
      })),
    ];
  }, [rows, t]);

  const authIndexOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.authIndex))).map((authIndex) => ({
        value: authIndex,
        label: authIndex,
      })),
    ],
    [rows, t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const authIndexOptionSet = useMemo(
    () => new Set(authIndexOptions.map((option) => option.value)),
    [authIndexOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveAuthIndexFilter = authIndexOptionSet.has(authIndexFilter)
    ? authIndexFilter
    : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.sourceKey === effectiveSourceFilter;
        const authIndexMatched =
          effectiveAuthIndexFilter === ALL_FILTER || row.authIndex === effectiveAuthIndexFilter;
        return modelMatched && sourceMatched && authIndexMatched;
      }),
    [effectiveAuthIndexFilter, effectiveModelFilter, effectiveSourceFilter, rows]
  );

  const renderedRows = useMemo(() => filteredRows.slice(0, MAX_RENDERED_EVENTS), [filteredRows]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveAuthIndexFilter !== ALL_FILTER;

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setAuthIndexFilter(ALL_FILTER);
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'auth_index',
      'result',
      ...(hasLatencyData ? ['latency_ms'] : []),
      'thinking_intensity',
      'thinking_mode',
      'thinking_level',
      'thinking_budget',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'total_tokens',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.authIndex,
        row.failed ? 'failed' : 'success',
        ...(hasLatencyData ? [row.latencyMs ?? ''] : []),
        row.thinking?.intensity ?? '',
        row.thinking?.mode ?? '',
        row.thinking?.level ?? '',
        row.thinking?.budget ?? '',
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.totalTokens,
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      auth_index: row.authIndex,
      failed: row.failed,
      ...(hasLatencyData && row.latencyMs !== null ? { latency_ms: row.latencyMs } : {}),
      ...(row.thinking ? { thinking: row.thinking } : {}),
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <div className={styles.requestEventsColumnConfig} ref={columnConfigRef}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setColumnConfigOpen((open) => !open)}
              title={t('usage_stats.column_config')}
              aria-expanded={columnConfigOpen}
              aria-haspopup="menu"
            >
              <IconSlidersHorizontal size={15} />
              {t('usage_stats.column_config')}
            </Button>
            {columnConfigOpen && (
              <div className={styles.requestEventsColumnPanel} role="menu">
                <div className={styles.requestEventsColumnPanelHeader}>
                  <span>{t('usage_stats.column_config')}</span>
                  <Button variant="ghost" size="sm" onClick={handleResetColumns}>
                    {t('usage_stats.column_config_reset')}
                  </Button>
                </div>
                <div className={styles.requestEventsColumnList}>
                  {availableColumnIds.map((columnId, index) => {
                    const column = columns[columnId];
                    const visible = !hiddenColumnIds.has(columnId);
                    return (
                      <div className={styles.requestEventsColumnItem} key={columnId}>
                        <SelectionCheckbox
                          checked={visible}
                          onChange={(checked) => handleToggleColumn(columnId, checked)}
                          disabled={visible && visibleColumnCount <= 1}
                          label={column.label}
                          ariaLabel={column.label}
                        />
                        <div className={styles.requestEventsColumnMoveActions}>
                          <button
                            type="button"
                            className={styles.requestEventsColumnIconButton}
                            onClick={() => handleMoveColumn(columnId, -1)}
                            disabled={index === 0}
                            title={t('usage_stats.column_config_move_up')}
                            aria-label={t('usage_stats.column_config_move_up')}
                          >
                            <IconChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            className={styles.requestEventsColumnIconButton}
                            onClick={() => handleMoveColumn(columnId, 1)}
                            disabled={index === availableColumnIds.length - 1}
                            title={t('usage_stats.column_config_move_down')}
                            aria-label={t('usage_stats.column_config_move_down')}
                          >
                            <IconChevronDown size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_auth_index')}
          </span>
          <Select
            value={effectiveAuthIndexFilter}
            options={authIndexOptions}
            onChange={setAuthIndexFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_auth_index')}
            fullWidth={false}
          />
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {hasLatencyData && <span className={styles.requestEventsLimitHint}>{latencyHint}</span>}
            {filteredRows.length > MAX_RENDERED_EVENTS && (
              <span className={styles.requestEventsLimitHint}>
                {t('usage_stats.request_events_limit_hint', {
                  shown: MAX_RENDERED_EVENTS,
                  total: filteredRows.length,
                })}
              </span>
            )}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={`${styles.table} ${styles.requestEventsTable}`}>
              <thead>
                <tr>
                  {visibleColumns.map((column) => (
                    <th key={column.id} title={column.headerTitle}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    {visibleColumns.map((column) => (
                      <Fragment key={column.id}>{column.cell(row)}</Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
