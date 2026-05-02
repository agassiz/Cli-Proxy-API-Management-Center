import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG,
  KIRO_CONFIG,
  COPILOT_CONFIG,
} from '@/components/quota';
import { useNotificationStore, useQuotaStore } from '@/stores';
import type {
  AntigravityQuotaBucket,
  AntigravityQuotaGroup,
  AntigravityQuotaState,
  AuthFileItem,
  CodexQuotaState,
  KiroQuotaState,
} from '@/types';
import { getStatusFromError, normalizePlanType, resolveCodexPlanType } from '@/utils/quota';
import {
  isRuntimeOnlyAuthFile,
  resolveQuotaErrorMessage,
  type QuotaProviderType,
} from '@/features/authFiles/constants';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { QuotaProgressBar } from '@/features/authFiles/components/QuotaProgressBar';
import { authFilesApi } from '@/services/api';
import styles from '@/pages/AuthFilesPage.module.scss';

type QuotaState = { status?: string; error?: string; errorStatus?: number } | undefined;
const noopQuotaStateUpdater = (() => undefined) as unknown as (updater: unknown) => void;
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);

const assertNever = (value: never): never => {
  throw new Error(`Unsupported quota type: ${value}`);
};

const getQuotaConfig = (type: QuotaProviderType) => {
  if (type === 'antigravity') return ANTIGRAVITY_CONFIG;
  if (type === 'claude') return CLAUDE_CONFIG;
  if (type === 'codex') return CODEX_CONFIG;
  if (type === 'kimi') return KIMI_CONFIG;
  if (type === 'xai') return XAI_CONFIG;
  if (type === 'kiro') return KIRO_CONFIG;
  if (type === 'github-copilot') return COPILOT_CONFIG;
  return assertNever(type);
};

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const buildEmbeddedAntigravityQuota = (file: AuthFileItem): AntigravityQuotaState | undefined => {
  const rawGroups = Array.isArray(file.antigravity_quota_groups)
    ? file.antigravity_quota_groups
    : [];
  const groups = rawGroups
    .map((raw): AntigravityQuotaGroup | null => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const id = normalizeString(item.id) ?? normalizeString(item.label);
      const label = normalizeString(item.label) ?? id;
      if (!id || !label) return null;
      const rawBuckets = Array.isArray(item.buckets) ? item.buckets : [];
      const buckets = rawBuckets
        .map((rawBucket, bucketIndex): AntigravityQuotaBucket | null => {
          if (!rawBucket || typeof rawBucket !== 'object') return null;
          const bucket = rawBucket as Record<string, unknown>;
          const bucketId =
            normalizeString(bucket.id ?? bucket.bucketId ?? bucket.bucket_id) ??
            `${id}-${bucketIndex + 1}`;
          const bucketLabel = normalizeString(bucket.label ?? bucket.displayName) ?? bucketId;
          const remainingFraction = normalizeNumber(
            bucket.remainingFraction ?? bucket.remaining_fraction
          );
          if (remainingFraction === null) return null;
          return {
            id: bucketId,
            label: bucketLabel,
            window: normalizeString(bucket.window) ?? undefined,
            remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
            resetTime: normalizeString(bucket.resetTime ?? bucket.reset_time) ?? undefined,
            description: normalizeString(bucket.description) ?? undefined,
          };
        })
        .filter((bucket): bucket is AntigravityQuotaBucket => bucket !== null);
      const legacyRemainingFraction = normalizeNumber(
        item.remainingFraction ?? item.remaining_fraction
      );
      if (buckets.length === 0 && legacyRemainingFraction === null) return null;
      return {
        id,
        label,
        description: normalizeString(item.description) ?? undefined,
        buckets:
          buckets.length > 0
            ? buckets
            : [
                {
                  id: `${id}-quota`,
                  label,
                  remainingFraction: Math.max(0, Math.min(1, legacyRemainingFraction ?? 0)),
                  resetTime: normalizeString(item.resetTime ?? item.reset_time) ?? undefined,
                },
              ],
      };
    })
    .filter((group): group is AntigravityQuotaGroup => group !== null);
  const creditBalance = normalizeNumber(file.credit_balance);

  if (groups.length === 0 && creditBalance === null) {
    return undefined;
  }
  return {
    status: 'success',
    groups,
    creditBalance,
  };
};

const resolveKiroSubscriptionTitle = (file: AuthFileItem): string | null => {
  const direct = normalizeString(file.subscription_title ?? file.subscriptionTitle);
  if (direct) return direct;

  const info = file.subscriptionInfo;
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const nested = normalizeString((info as Record<string, unknown>).subscriptionTitle);
    if (nested) return nested;
  }

  const tier = normalizeString(file.subscription_tier ?? file.subscription_type)?.toLowerCase();
  if (tier === 'pro' || tier === 'paid') return 'KIRO PRO';
  if (tier === 'free' || tier === 'free_trial') return 'KIRO FREE';
  return null;
};

const buildEmbeddedCodexQuota = (file: AuthFileItem): CodexQuotaState | undefined => {
  const planType = resolveCodexPlanType(file);
  if (!planType) return undefined;
  return {
    status: 'success',
    windows: [],
    planType,
  };
};

const buildEmbeddedKiroQuota = (file: AuthFileItem): KiroQuotaState | undefined => {
  const subscriptionTitle = resolveKiroSubscriptionTitle(file);
  if (!subscriptionTitle) return undefined;
  return {
    status: 'success',
    subscriptionTitle,
    baseQuota: null,
    freeTrialQuota: null,
    overageQuota: null,
  };
};

const getCodexPlanLabel = (planType: string | null | undefined, t: TFunction): string | null => {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
};

const isCodexQuotaWithoutWindows = (quota: unknown): quota is CodexQuotaState => {
  return Boolean(
    quota &&
    typeof quota === 'object' &&
    'windows' in quota &&
    Array.isArray((quota as CodexQuotaState).windows) &&
    (quota as CodexQuotaState).windows.length === 0
  );
};

const isKiroQuotaWithoutDetails = (quota: unknown): quota is KiroQuotaState => {
  return Boolean(
    quota &&
    typeof quota === 'object' &&
    'baseQuota' in quota &&
    'freeTrialQuota' in quota &&
    !(quota as KiroQuotaState).baseQuota &&
    !(quota as KiroQuotaState).freeTrialQuota &&
    !(quota as KiroQuotaState).overageQuota
  );
};

const syncAntigravityQuotaDisplay = async (file: AuthFileItem, data: unknown) => {
  if (!data || typeof data !== 'object') return;
  const payload = data as { groups?: unknown[]; creditBalance?: number | string | null };
  if (!Array.isArray(payload.groups) || payload.groups.length === 0) return;
  await authFilesApi.syncQuotaDisplay(file.name, {
    provider: 'antigravity',
    antigravity_quota_groups: payload.groups,
    credit_balance: payload.creditBalance,
  });
};

export type AuthFileQuotaSectionProps = {
  file: AuthFileItem;
  quotaType: QuotaProviderType;
  disableControls: boolean;
};

export function useAuthFileQuotaRefresh(
  file: AuthFileItem,
  quotaType: QuotaProviderType | null,
  disableControls: boolean
) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [resettingQuota, setResettingQuota] = useState(false);

  const quota = useQuotaStore((state) => {
    if (!quotaType) return undefined;
    if (quotaType === 'antigravity') return state.antigravityQuota[file.name] as QuotaState;
    if (quotaType === 'claude') return state.claudeQuota[file.name] as QuotaState;
    if (quotaType === 'codex') return state.codexQuota[file.name] as QuotaState;
    if (quotaType === 'kimi') return state.kimiQuota[file.name] as QuotaState;
    if (quotaType === 'xai') return state.xaiQuota[file.name] as QuotaState;
    if (quotaType === 'kiro') return state.kiroQuota[file.name] as QuotaState;
    if (quotaType === 'github-copilot') return state.copilotQuota[file.name] as QuotaState;
    return assertNever(quotaType);
  });
  const embeddedQuota =
    quotaType === 'antigravity'
      ? (buildEmbeddedAntigravityQuota(file) as QuotaState)
      : quotaType === 'codex'
        ? (buildEmbeddedCodexQuota(file) as QuotaState)
        : quotaType === 'kiro'
          ? (buildEmbeddedKiroQuota(file) as QuotaState)
          : undefined;
  const effectiveQuota = quota ?? embeddedQuota;

  const updateQuotaState = useQuotaStore((state) => {
    if (!quotaType) return noopQuotaStateUpdater;
    if (quotaType === 'antigravity')
      return state.setAntigravityQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'claude')
      return state.setClaudeQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'codex') return state.setCodexQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'kimi') return state.setKimiQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'xai') return state.setXaiQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'kiro') return state.setKiroQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'github-copilot')
      return state.setCopilotQuota as unknown as (updater: unknown) => void;
    return assertNever(quotaType);
  });

  const requestAuthFilesRefresh = useCallback(() => {
    window.dispatchEvent(new Event('auth-files-refresh'));
  }, []);

  const refreshQuotaForFile = useCallback(async () => {
    if (!quotaType) return;
    if (disableControls) return;
    if (isRuntimeOnlyAuthFile(file)) return;
    if (file.disabled) return;
    if (quota?.status === 'loading') return;

    const config = getQuotaConfig(quotaType) as unknown as {
      i18nPrefix: string;
      fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
      buildLoadingState: () => unknown;
      buildSuccessState: (data: unknown) => unknown;
      buildErrorState: (message: string, status?: number) => unknown;
      renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
    };

    updateQuotaState((prev: Record<string, unknown>) => ({
      ...prev,
      [file.name]: config.buildLoadingState(),
    }));

    try {
      const data = await config.fetchQuota(file, t);
      if (quotaType === 'antigravity') {
        await syncAntigravityQuotaDisplay(file, data);
      }
      updateQuotaState((prev: Record<string, unknown>) => ({
        ...prev,
        [file.name]: config.buildSuccessState(data),
      }));
      requestAuthFilesRefresh();
      showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      const status = getStatusFromError(err);
      updateQuotaState((prev: Record<string, unknown>) => ({
        ...prev,
        [file.name]: config.buildErrorState(message, status),
      }));
      requestAuthFilesRefresh();
      showNotification(t('auth_files.quota_refresh_failed', { name: file.name, message }), 'error');
    }
  }, [
    disableControls,
    file,
    quota?.status,
    quotaType,
    requestAuthFilesRefresh,
    showNotification,
    t,
    updateQuotaState,
  ]);

  const resetQuotaForFile = useCallback(() => {
    if (!quotaType) return;
    if (disableControls) return;
    if (isRuntimeOnlyAuthFile(file)) return;
    if (file.disabled) return;
    if (effectiveQuota?.status === 'loading') return;
    if (resettingQuota) return;

    const config = getQuotaConfig(quotaType) as unknown as {
      resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
      buildSuccessState: (data: unknown) => unknown;
    };
    const resetQuota = config.resetQuota;
    if (!resetQuota) return;

    showConfirmation({
      title: t('codex_quota.reset_confirm_title'),
      message: t('codex_quota.reset_confirm_message', { name: file.name }),
      confirmText: t('codex_quota.reset_confirm_button'),
      variant: 'primary',
      onConfirm: async () => {
        setResettingQuota(true);
        try {
          const data = await resetQuota(file, t);
          updateQuotaState((prev: Record<string, unknown>) => ({
            ...prev,
            [file.name]: config.buildSuccessState(data),
          }));
          showNotification(t('codex_quota.reset_success', { name: file.name }), 'success');
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          showNotification(t('codex_quota.reset_failed', { name: file.name, message }), 'error');
        } finally {
          setResettingQuota(false);
        }
      },
    });
  }, [
    disableControls,
    effectiveQuota?.status,
    file,
    quotaType,
    resettingQuota,
    showConfirmation,
    showNotification,
    t,
    updateQuotaState,
  ]);

  const quotaStatus = effectiveQuota?.status ?? 'idle';
  const canRefreshQuota = Boolean(quotaType) && !disableControls && !file.disabled && !resettingQuota;

  return {
    quota: effectiveQuota,
    quotaStatus,
    canRefreshQuota,
    refreshQuotaForFile,
    resetQuotaForFile,
    resettingQuota,
  };
}

export function AuthFileQuotaSection(props: AuthFileQuotaSectionProps) {
  const { file, quotaType, disableControls } = props;
  const { t } = useTranslation();
  const {
    quota,
    quotaStatus,
    canRefreshQuota,
    refreshQuotaForFile,
    resetQuotaForFile,
    resettingQuota,
  } = useAuthFileQuotaRefresh(file, quotaType, disableControls);
  const config = getQuotaConfig(quotaType) as unknown as {
    i18nPrefix: string;
    resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
    canResetQuota?: (quota: unknown) => boolean;
    renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
  };
  const canUseResetQuota = canRefreshQuota && quotaStatus !== 'loading';
  const showResetQuotaAction = quota !== undefined && Boolean(config.canResetQuota?.(quota));
  const resetQuotaAction = config.resetQuota && showResetQuotaAction ? (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={styles.quotaResetCreditButton}
      onClick={() => resetQuotaForFile()}
      disabled={!canUseResetQuota}
      loading={resettingQuota}
      title={t('codex_quota.reset_button')}
      aria-label={t('codex_quota.reset_button')}
    >
      {!resettingQuota && <IconRefreshCw size={14} />}
      {t('codex_quota.reset_button')}
    </Button>
  ) : undefined;
  const quotaErrorStatus =
    quota && typeof quota === 'object' && 'errorStatus' in quota ? quota.errorStatus : undefined;
  const quotaError =
    quota && typeof quota === 'object' && 'error' in quota ? quota.error : undefined;
  const quotaErrorMessage = resolveQuotaErrorMessage(
    t,
    quotaErrorStatus,
    quotaError || t('common.unknown_error')
  );
  const renderQuotaRefreshAction = () => (
    <button
      type="button"
      className={`${styles.quotaMessage} ${styles.quotaMessageAction}`}
      onClick={() => void refreshQuotaForFile()}
      disabled={!canRefreshQuota}
    >
      {t(`${config.i18nPrefix}.idle`)}
    </button>
  );
  const renderQuotaSuccessItems = () => {
    if (quotaType === 'codex' && isCodexQuotaWithoutWindows(quota)) {
      const planLabel = getCodexPlanLabel(quota.planType, t);
      const isPremiumPlan = PREMIUM_CODEX_PLAN_TYPES.has(normalizePlanType(quota.planType) ?? '');

      return (
        <>
          {planLabel ? (
            <div className={styles.codexPlan}>
              <span className={styles.codexPlanLabel}>{t('codex_quota.plan_label')}</span>
              <span className={isPremiumPlan ? styles.premiumPlanValue : styles.codexPlanValue}>
                {planLabel}
              </span>
            </div>
          ) : null}
          {renderQuotaRefreshAction()}
        </>
      );
    }

    if (quotaType === 'kiro' && isKiroQuotaWithoutDetails(quota)) {
      return (
        <>
          {quota.subscriptionTitle ? (
            <div className={styles.codexPlan}>
              <span className={styles.codexPlanLabel}>{t('kiro_quota.subscription_label')}</span>
              <span className={styles.codexPlanValue}>{quota.subscriptionTitle}</span>
            </div>
          ) : null}
          {renderQuotaRefreshAction()}
        </>
      );
    }

    return config.renderQuotaItems(quota, t, { styles, QuotaProgressBar }) as ReactNode;
  };

  return (
    <div className={styles.quotaSection}>
      {quotaStatus === 'loading' ? (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.loading`)}</div>
      ) : quotaStatus === 'idle' ? (
        renderQuotaRefreshAction()
      ) : quotaStatus === 'error' ? (
        <div className={styles.quotaError}>
          {t(`${config.i18nPrefix}.load_failed`, {
            message: quotaErrorMessage,
          })}
        </div>
      ) : quota ? (
        renderQuotaSuccessItems()
      ) : (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
      )}
      {quotaStatus !== 'idle' && resetQuotaAction && (
        <div className={styles.quotaCardActions}>{resetQuotaAction}</div>
      )}
    </div>
  );
}
