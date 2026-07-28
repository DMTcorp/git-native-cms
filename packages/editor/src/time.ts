const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function dateParts(source: string): {
  readonly month: string;
  readonly day: number;
  readonly year: number;
  readonly hour: number;
  readonly minute: string;
} | undefined {
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) return undefined;
  return {
    month: months[date.getUTCMonth()] ?? "",
    day: date.getUTCDate(),
    year: date.getUTCFullYear(),
    hour: date.getUTCHours(),
    minute: String(date.getUTCMinutes()).padStart(2, "0"),
  };
}

export function formatCmsDate(source: string): string {
  const value = dateParts(source);
  return value === undefined ? source : `${value.month} ${String(value.day)}, ${String(value.year)}`;
}

export function formatCmsTimestamp(source: string): string {
  const value = dateParts(source);
  if (value === undefined) return source;
  const period = value.hour >= 12 ? "PM" : "AM";
  const hour = value.hour % 12 || 12;
  return `${value.month} ${String(value.day)}, ${String(hour).padStart(2, "0")}:${value.minute} ${period} UTC`;
}
