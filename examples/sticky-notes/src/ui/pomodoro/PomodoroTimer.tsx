export interface PomodoroTimerProps {
  focusMinutes: number;
  breakMinutes: number;
  onComplete: (kind: 'focus' | 'break') => void;
}

/** 番茄钟 UI 外壳（业务计时逻辑在 pomodoro-service，尚未开工）。 */
export function PomodoroTimer({ focusMinutes, breakMinutes, onComplete }: PomodoroTimerProps) {
  return (
    <div className="pomodoro">
      <button onClick={() => onComplete('focus')}>{focusMinutes} 分钟专注</button>
      <button onClick={() => onComplete('break')}>{breakMinutes} 分钟休息</button>
    </div>
  );
}
