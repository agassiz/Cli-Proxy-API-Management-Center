import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { normalizeUsageTotal } from '@/utils/recentRequests';
import type { QuotaProviderType, ResolvedTheme } from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { AuthFileCard } from './AuthFileCard';
import styles from '@/pages/AuthFilesPage.module.scss';

export type SuperCategoryGroupCardProps = {
  files: AuthFileItem[];
  compact: boolean;
  hideErrors?: boolean;
  selectedFiles: Set<string>;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  quotaFilterType: QuotaProviderType | null;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
};

export function SuperCategoryGroupCard(props: SuperCategoryGroupCardProps) {
  const { t } = useTranslation();
  const {
    files,
    compact,
    hideErrors = false,
    selectedFiles,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    quotaFilterType,
    statusBarCache,
    onShowModels,
    onDownload,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
  } = props;

  const [expanded, setExpanded] = useState(false);

  const aggregatedStats = useMemo(() => {
    let totalSuccess = 0;
    let totalFailure = 0;
    for (const file of files) {
      totalSuccess += normalizeUsageTotal(file.success);
      totalFailure += normalizeUsageTotal(file.failed);
    }
    const total = totalSuccess + totalFailure;
    const healthPercent = total > 0 ? (totalSuccess / total) * 100 : 100;
    return { totalSuccess, totalFailure, healthPercent };
  }, [files]);

  const healthColor =
    aggregatedStats.healthPercent >= 90
      ? 'var(--success-color, #22c55e)'
      : aggregatedStats.healthPercent >= 50
        ? 'var(--warning-color, #facc15)'
        : 'var(--danger-color, #ef4444)';

  const healthBarWidth = `${Math.max(0, Math.min(100, aggregatedStats.healthPercent))}%`;

  if (files.length === 0) return null;

  return (
    <div className={styles.superCategoryGroup}>
      <button
        type="button"
        className={styles.superCategoryGroupHeader}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <div className={styles.superCategoryGroupTitle}>
          <span className={styles.superCategoryGroupIcon}>⚡</span>
          <span className={styles.superCategoryGroupName}>
            {t('auth_files.super_category_group_title')}
          </span>
          <span className={styles.superCategoryGroupCount}>
            {t('auth_files.super_category_group_count', { count: files.length })}
          </span>
        </div>

        <div className={styles.superCategoryGroupStats}>
          <div className={styles.superCategoryGroupStatPills}>
            <span className={`${styles.statPill} ${styles.statSuccess}`}>
              <span className={styles.statLabel}>{t('stats.success')}</span>
              <span className={styles.statValue}>{aggregatedStats.totalSuccess}</span>
            </span>
            <span className={`${styles.statPill} ${styles.statFailure}`}>
              <span className={styles.statLabel}>{t('stats.failure')}</span>
              <span className={styles.statValue}>{aggregatedStats.totalFailure}</span>
            </span>
          </div>

          <div className={styles.superCategoryGroupHealth}>
            <span className={styles.superCategoryGroupHealthLabel}>
              {t('auth_files.super_category_group_health')}
            </span>
            <div className={styles.superCategoryGroupHealthBar}>
              <div
                className={styles.superCategoryGroupHealthFill}
                style={{ width: healthBarWidth, backgroundColor: healthColor }}
              />
            </div>
            <span
              className={styles.superCategoryGroupHealthValue}
              style={{ color: healthColor }}
            >
              {aggregatedStats.healthPercent.toFixed(1)}%
            </span>
          </div>
        </div>

        <span className={styles.superCategoryGroupChevron} data-expanded={expanded}>
          ▾
        </span>
      </button>

      {expanded && (
        <div className={styles.superCategoryGroupBody}>
          <div
            className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''} ${compact ? styles.fileGridCompact : ''}`}
          >
            {files.map((file) => (
              <AuthFileCard
                key={file.name}
                file={file}
                compact={compact}
                hideErrors={hideErrors}
                selected={selectedFiles.has(file.name)}
                resolvedTheme={resolvedTheme}
                disableControls={disableControls}
                deleting={deleting}
                statusUpdating={statusUpdating}
                quotaFilterType={quotaFilterType}
                statusBarCache={statusBarCache}
                onShowModels={onShowModels}
                onDownload={onDownload}
                onOpenPrefixProxyEditor={onOpenPrefixProxyEditor}
                onDelete={onDelete}
                onToggleStatus={onToggleStatus}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
