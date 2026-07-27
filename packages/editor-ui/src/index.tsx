import {
  Button as AriaButton,
  Input,
  Label,
  TextField as AriaTextField,
  type ButtonProps,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import type { ReactElement, ReactNode } from "react";

export function Button(
  props: ButtonProps & { readonly tone?: "primary" | "neutral" | "danger" },
): ReactElement {
  const { tone = "neutral", className, ...buttonProps } = props;
  return (
    <AriaButton
      {...buttonProps}
      className={`cms-button cms-button--${tone}${typeof className === "string" ? ` ${className}` : ""}`}
    />
  );
}

export function TextField(
  props: AriaTextFieldProps & {
    readonly label: string;
    readonly value?: string;
    readonly onChange?: (value: string) => void;
  },
): ReactElement {
  const { label, ...fieldProps } = props;
  return (
    <AriaTextField {...fieldProps} className="cms-field">
      <Label className="cms-field__label">{label}</Label>
      <Input className="cms-field__input" />
    </AriaTextField>
  );
}

export function StatusBadge(props: {
  readonly tone: "draft" | "review" | "staging" | "live" | "error";
  readonly children: ReactNode;
}): ReactElement {
  return <span className={`cms-status cms-status--${props.tone}`}>{props.children}</span>;
}

const STEPS = [
  { key: "change", label: "Change" },
  { key: "review", label: "Review" },
  { key: "staging", label: "Staging" },
  { key: "live", label: "Live" },
] as const;

export function ChangeRail(props: {
  readonly current: (typeof STEPS)[number]["key"];
}): ReactElement {
  const currentIndex = STEPS.findIndex((step) => step.key === props.current);
  return (
    <ol className="cms-change-rail" aria-label="Publication progress">
      {STEPS.map((step, index) => (
        <li
          key={step.key}
          className={
            index < currentIndex
              ? "cms-change-rail__step is-complete"
              : index === currentIndex
                ? "cms-change-rail__step is-current"
                : "cms-change-rail__step"
          }
          aria-current={index === currentIndex ? "step" : undefined}
        >
          <span aria-hidden="true" />
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export function EmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className="cms-empty">
      <p className="cms-empty__eyebrow">Nothing here yet</p>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}
