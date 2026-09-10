import { z } from "zod";

/**
 * Minimal shapes for the Oura v2 responses this server reads. Unknown keys are stripped,
 * so a field Oura adds tomorrow can't break us; a field we rely on going missing fails
 * loudly at the client boundary instead of turning into a misleading number downstream.
 */

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

export const SleepPeriodSchema = z.object({
  id: z.string(),
  day: z.string(),
  type: z.string(),
  bedtime_start: z.string(),
  bedtime_end: z.string(),
  total_sleep_duration: num, time_in_bed: num, efficiency: num, latency: num,
  lowest_heart_rate: num, average_heart_rate: num, average_hrv: num, average_breath: num,
  heart_rate: z.object({ interval: z.number(), items: z.array(z.number().nullable()), timestamp: z.string() }).nullable().optional(),
  readiness: z.object({ score: num, temperature_deviation: num }).nullable().optional(),
});

export const DailySleepSchema = z.object({ day: z.string(), score: num });

export const DailyReadinessSchema = z.object({
  day: z.string(),
  score: num,
  temperature_deviation: num,
  temperature_trend_deviation: num,
  contributors: z.record(z.number().nullable()).optional(),
});

export const DailyActivitySchema = z.object({ day: z.string(), score: num, steps: num });

export const DailyStressSchema = z.object({ day: z.string(), stress_high: num, recovery_high: num, day_summary: str });

export const DailySpo2Schema = z.object({
  day: z.string(),
  spo2_percentage: z.object({ average: num }).nullable().optional(),
});

export const EnhancedTagSchema = z.object({
  id: z.string(),
  day: z.string(),
  start_time: str, end_time: str, tag_type_code: str, comment: str, custom_name: str,
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), next_token: z.string().nullable().optional() });

export type SleepPeriod = z.infer<typeof SleepPeriodSchema>;
export type DailySleep = z.infer<typeof DailySleepSchema>;
export type DailyReadiness = z.infer<typeof DailyReadinessSchema>;
export type DailyActivity = z.infer<typeof DailyActivitySchema>;
export type DailyStress = z.infer<typeof DailyStressSchema>;
export type DailySpo2 = z.infer<typeof DailySpo2Schema>;
export type EnhancedTag = z.infer<typeof EnhancedTagSchema>;
