import { useEffect, useState, type ReactNode } from 'react';
import type { ValidationIssue } from '../types';

export function Panel({ title, subtitle, actions, children, className = '' }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function NumberField({ label, value, onChange, step = 1, min, max, unit, hint, disabled }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(Number.isFinite(value) ? Math.round(value * 100000) / 100000 : ''));
  useEffect(() => {
    const next = String(Number.isFinite(value) ? Math.round(value * 100000) / 100000 : '');
    if (Number.parseFloat(text) !== value) setText(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className={`field ${disabled ? 'disabled' : ''}`}>
      <span className="field-label">{label}{unit && <em>{unit}</em>}</span>
      <input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) onChange(v);
        }}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i className="switch" />
    </label>
  );
}

export function Badge({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'green' | 'red' | 'amber' | 'gray' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Stat({ label, value, unit, tone }: { label: string; value: ReactNode; unit?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span>{label}</span>
      <b>{value}{unit && <em>{unit}</em>}</b>
    </div>
  );
}

export function IssueList({ issues, onRepairOne, onRepairAll, compact }: {
  issues: ValidationIssue[];
  onRepairOne?: (id: string) => void;
  onRepairAll?: () => void;
  compact?: boolean;
}) {
  if (!issues.length) return <div className="ok-box">参数诊断通过：未发现数量级或几何阻断问题。</div>;
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <div className="issue-list">
      <div className="issue-summary">
        <Badge tone={errors ? 'red' : 'amber'}>{errors} 错误 / {issues.length - errors} 警告</Badge>
        {onRepairAll && issues.some((i) => i.repairable) && (
          <button className="btn btn-small btn-primary" onClick={onRepairAll}>一键采用推荐值修复</button>
        )}
      </div>
      {!compact && issues.map((issue) => (
        <div key={issue.id} className={`issue issue-${issue.severity}`}>
          <div>
            <b>[{issue.severity}] {issue.targetName ?? issue.scope} · {issue.field}</b>
            <p>{issue.message}</p>
            {issue.expectedRange && <small>合理区间：{issue.expectedRange[0]}–{issue.expectedRange[1]}；建议值：{String(issue.suggestedValue)}</small>}
          </div>
          {issue.repairable && onRepairOne && (
            <button className="btn btn-small" onClick={() => onRepairOne(issue.id)}>修复</button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
