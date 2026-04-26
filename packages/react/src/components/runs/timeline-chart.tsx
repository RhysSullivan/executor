"use client";

import * as React from "react";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ReferenceArea, XAxis } from "recharts";

type RechartsMouseEvent = { readonly activeLabel?: string | number };
import type { ExecutionChartBucket } from "../../api/executions";

import { cn } from "../../lib/utils";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../chart";
import { STATUS_LABELS, STATUS_TONES } from "./status";

const TIMELINE_CONFIG: ChartConfig = {
  completed: { label: STATUS_LABELS.completed, color: STATUS_TONES.completed.chartFill },
  failed: { label: STATUS_LABELS.failed, color: STATUS_TONES.failed.chartFill },
  running: { label: STATUS_LABELS.running, color: STATUS_TONES.running.chartFill },
  waiting_for_interaction: {
    label: STATUS_LABELS.waiting_for_interaction,
    color: STATUS_TONES.waiting_for_interaction.chartFill,
  },
  cancelled: { label: STATUS_LABELS.cancelled, color: STATUS_TONES.cancelled.chartFill },
  pending: { label: STATUS_LABELS.pending, color: STATUS_TONES.pending.chartFill },
};

const BAR_STACK_ORDER = [
  "failed",
  "cancelled",
  "waiting_for_interaction",
  "running",
  "pending",
  "completed",
] as const;

const pickAxisLabelFormatter = (bucketMs: number) => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  if (bucketMs <= MIN) {
    return (value: string) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : format(date, "HH:mm:ss");
    };
  }
  if (bucketMs < HOUR) {
    return (value: string) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : format(date, "HH:mm");
    };
  }
  if (bucketMs < DAY) {
    return (value: string) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : format(date, "HH:mm");
    };
  }
  return (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : format(date, "LLL dd");
  };
};

const pickTooltipLabelFormatter = (bucketMs: number) => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  return (value: unknown) => {
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "—";
    if (bucketMs <= MIN) return format(date, "LLL dd, HH:mm:ss");
    if (bucketMs < HOUR) return format(date, "LLL dd, HH:mm");
    return format(date, "LLL dd, y HH:mm");
  };
};

export interface TimelineChartProps {
  readonly data: readonly ExecutionChartBucket[];
  readonly bucketMs: number;
  readonly className?: string;
  readonly onRangeSelect?: (range: { readonly from: number; readonly to: number }) => void;
}

export function TimelineChart({ data, bucketMs, className, onRangeSelect }: TimelineChartProps) {
  const [refAreaLeft, setRefAreaLeft] = React.useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = React.useState<string | null>(null);
  const isSelectingRef = React.useRef(false);

  const chartRows = React.useMemo(
    () =>
      data.map((bucket) => ({
        ...bucket,
        date: new Date(bucket.bucketStart).toISOString(),
      })),
    [data],
  );

  const axisLabelFormatter = React.useMemo(() => pickAxisLabelFormatter(bucketMs), [bucketMs]);
  const tooltipLabelFormatter = React.useMemo(
    () => pickTooltipLabelFormatter(bucketMs),
    [bucketMs],
  );

  const handleMouseDown = (event: RechartsMouseEvent | null | undefined) => {
    if (event?.activeLabel != null) {
      setRefAreaLeft(String(event.activeLabel));
      isSelectingRef.current = true;
    }
  };

  const handleMouseMove = (event: RechartsMouseEvent | null | undefined) => {
    if (isSelectingRef.current && event?.activeLabel != null) {
      setRefAreaRight(String(event.activeLabel));
    }
  };

  const handleMouseUp = () => {
    if (refAreaLeft && refAreaRight && onRangeSelect) {
      const [lStr, rStr] = [refAreaLeft, refAreaRight].sort(
        (a, b) => new Date(a).getTime() - new Date(b).getTime(),
      );
      const from = new Date(lStr).getTime();
      const to = new Date(rStr).getTime() + bucketMs; // include the bucket
      if (from < to) {
        onRangeSelect({ from, to });
      }
    }
    setRefAreaLeft(null);
    setRefAreaRight(null);
    isSelectingRef.current = false;
  };

  if (chartRows.length === 0) {
    return (
      <div
        className={cn(
          "flex h-[60px] items-center justify-center text-[10px] font-mono uppercase tracking-wider text-muted-foreground/40",
          className,
        )}
      >
        No activity in range
      </div>
    );
  }

  return (
    <ChartContainer
      config={TIMELINE_CONFIG}
      className={cn(
        "aspect-auto h-[72px] w-full",
        "[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/40",
        "select-none",
        className,
      )}
    >
      <BarChart
        accessibilityLayer
        data={chartRows}
        margin={{ top: 0, left: 0, right: 0, bottom: 0 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: "crosshair" }}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.25} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          minTickGap={32}
          tickFormatter={axisLabelFormatter}
        />
        <ChartTooltip
          cursor={false}
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
          content={<ChartTooltipContent labelFormatter={tooltipLabelFormatter} />}
        />
        {BAR_STACK_ORDER.map((status) => (
          <Bar
            key={status}
            dataKey={status}
            stackId="timeline"
            fill={STATUS_TONES[status].chartFill}
            isAnimationActive={false}
          />
        ))}
        {refAreaLeft && refAreaRight ? (
          <ReferenceArea
            x1={refAreaLeft}
            x2={refAreaRight}
            strokeOpacity={0.3}
            fill="var(--foreground)"
            fillOpacity={0.08}
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  );
}
