import {
  Button as AriaButton,
  Cell,
  Column,
  Dialog,
  DialogTrigger,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Row,
  Select,
  SelectValue,
  Tab,
  Table,
  TableBody,
  TableHeader,
  TabList,
  TabPanel,
  Tabs,
  TextField as AriaTextField,
  Tooltip,
  TooltipTrigger,
  Tree,
  TreeItem,
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

export function SelectField(props: {
  readonly label: string;
  readonly value?: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly isDisabled?: boolean;
}): ReactElement {
  return (
    <Select
      className="cms-field"
      value={props.value ?? null}
      {...(props.isDisabled === undefined ? {} : { isDisabled: props.isDisabled })}
      onChange={(key) => {
        if (key !== null) props.onChange(String(key));
      }}
    >
      <Label className="cms-field__label">{props.label}</Label>
      <AriaButton className="cms-select-trigger">
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </AriaButton>
      <Popover className="cms-popover">
        <ListBox items={props.options} className="cms-listbox">
          {(option) => <ListBoxItem id={option.value}>{option.label}</ListBoxItem>}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function CmsDialog(props: {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <DialogTrigger>
      {props.trigger}
      <ModalOverlay className="cms-modal-overlay" isDismissable>
        <Modal className="cms-modal">
          <Dialog className="cms-dialog">
            {({ close }) => (
              <>
                <header>
                  <Heading slot="title">{props.title}</Heading>
                  <AriaButton aria-label="Close dialog" onPress={close}>
                    ×
                  </AriaButton>
                </header>
                {props.children}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

export function CmsTooltip(props: {
  readonly label: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <TooltipTrigger delay={350}>
      {props.children}
      <Tooltip className="cms-tooltip">{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

export function CmsTabs(props: {
  readonly label: string;
  readonly selectedKey: string;
  readonly onSelectionChange: (key: string) => void;
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly content: ReactNode;
  }[];
}): ReactElement {
  return (
    <Tabs
      aria-label={props.label}
      selectedKey={props.selectedKey}
      onSelectionChange={(key) => props.onSelectionChange(String(key))}
      className="cms-tabs"
    >
      <TabList>
        {props.items.map((item) => (
          <Tab key={item.key} id={item.key}>
            {item.label}
          </Tab>
        ))}
      </TabList>
      {props.items.map((item) => (
        <TabPanel key={item.key} id={item.key}>
          {item.content}
        </TabPanel>
      ))}
    </Tabs>
  );
}

export function ActionMenu(props: {
  readonly label: string;
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly tone?: "neutral" | "danger";
  }[];
  readonly onAction: (key: string) => void;
}): ReactElement {
  return (
    <MenuTrigger>
      <AriaButton className="cms-button cms-button--neutral" aria-label={props.label}>
        {props.label}
      </AriaButton>
      <Popover className="cms-popover">
        <Menu
          className="cms-menu"
          items={props.items}
          onAction={(key) => props.onAction(String(key))}
        >
          {(item) => (
            <MenuItem id={item.key} className={item.tone === "danger" ? "is-danger" : ""}>
              {item.label}
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

export function InlineToast(props: {
  readonly title: string;
  readonly description?: string;
  readonly tone?: "neutral" | "success" | "error";
  readonly onDismiss?: () => void;
}): ReactElement {
  return (
    <div
      className={`cms-toast cms-toast--${props.tone ?? "neutral"}`}
      role={props.tone === "error" ? "alert" : "status"}
    >
      <div>
        <strong>{props.title}</strong>
        {props.description !== undefined && <p>{props.description}</p>}
      </div>
      {props.onDismiss !== undefined && (
        <AriaButton aria-label="Dismiss notification" onPress={props.onDismiss}>
          ×
        </AriaButton>
      )}
    </div>
  );
}

export function Splitter(props: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly direction?: 1 | -1;
  readonly onChange: (value: number) => void;
}): ReactElement {
  const minimum = props.min ?? 20;
  const maximum = props.max ?? 80;
  const direction = props.direction ?? 1;
  const clamp = (value: number): number => Math.max(minimum, Math.min(maximum, value));
  return (
    <div
      className="cms-splitter"
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={props.value}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startValue = props.value;
        const move = (moveEvent: PointerEvent): void => {
          props.onChange(clamp(startValue + (moveEvent.clientX - startX) * direction));
        };
        const finish = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish, { once: true });
        window.addEventListener("pointercancel", finish, { once: true });
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") props.onChange(clamp(props.value - 8 * direction));
        if (event.key === "ArrowRight") props.onChange(clamp(props.value + 8 * direction));
      }}
    />
  );
}

export function DataTable(props: {
  readonly label: string;
  readonly columns: readonly {
    readonly key: string;
    readonly label: string;
    readonly rowHeader?: boolean;
  }[];
  readonly rows: readonly {
    readonly id: string;
    readonly values: Readonly<Record<string, ReactNode>>;
  }[];
}): ReactElement {
  return (
    <Table aria-label={props.label} className="cms-data-table">
      <TableHeader>
        {props.columns.map((column) => (
          <Column
            key={column.key}
            id={column.key}
            {...(column.rowHeader === undefined ? {} : { isRowHeader: column.rowHeader })}
          >
            {column.label}
          </Column>
        ))}
      </TableHeader>
      <TableBody>
        {props.rows.map((row) => (
          <Row key={row.id} id={row.id}>
            {props.columns.map((column) => (
              <Cell key={column.key}>{row.values[column.key]}</Cell>
            ))}
          </Row>
        ))}
      </TableBody>
    </Table>
  );
}

export function ContentTree(props: {
  readonly label: string;
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly selectedId?: string;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  return (
    <Tree
      aria-label={props.label}
      className="cms-content-tree"
      selectionMode="single"
      selectedKeys={props.selectedId === undefined ? new Set() : new Set([props.selectedId])}
      onSelectionChange={(selection) => {
        if (selection === "all") return;
        const key = [...selection][0];
        if (key !== undefined) props.onSelect(String(key));
      }}
    >
      {props.items.map((item) => (
        <TreeItem key={item.id} id={item.id} textValue={item.label}>
          {item.label}
        </TreeItem>
      ))}
    </Tree>
  );
}

export function CommandPalette(props: {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly commands: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly onAction: (id: string) => void;
}): ReactElement {
  return (
    <ModalOverlay
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="cms-modal-overlay"
      isDismissable
    >
      <Modal className="cms-command-palette">
        <Dialog aria-label="Command palette">
          <Input
            aria-label="Search commands"
            autoFocus
            value={props.query}
            onChange={(event) => props.onQueryChange(event.currentTarget.value)}
            placeholder="Type a command…"
          />
          <div role="listbox" aria-label="Commands">
            {props.commands.map((command) => (
              <button
                type="button"
                key={command.id}
                role="option"
                onClick={() => props.onAction(command.id)}
              >
                <strong>{command.label}</strong>
                {command.description !== undefined && <small>{command.description}</small>}
              </button>
            ))}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
