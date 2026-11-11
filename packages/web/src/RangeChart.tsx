import { useMemo, useRef, useState } from 'react';
import { damageAtRange, type Analysis } from '@mwo/shared';
import { fixed, t } from './i18n.ts';

const W = 640;
const H = 220;
const PAD = { left: 40, right: 28, top: 12, bottom: 28 };
const STEP = 10;

/** Alpha damage over distance for the whole build, one line. */
export function RangeChart({ a }: { a: Analysis }) {
  const combat = useMemo(() => a.weapons.filter((w) => w.weapon.hardpoint !== 'ams' && w.weapon.ranges.length > 0), [a.weapons]);
  const maxRange = Math.max(0, ...combat.map((w) => w.maxRange));
  const points = useMemo(() => {
    const out: { r: number; d: number }[] = [];
    for (let r = 0; r <= maxRange + STEP; r += STEP) out.push({ r, d: damageAtRange(combat, r) });
    return out;
  }, [combat, maxRange]);
  const [hover, setHover] = useState<{ r: number; d: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (combat.length === 0 || maxRange <= 0) return null;

  const maxDamage = Math.max(1, ...points.map((p) => p.d));
  const xMax = Math.ceil((maxRange + STEP) / 100) * 100;
  const yMax = niceMax(maxDamage);
  const x = (r: number) => PAD.left + (r / xMax) * (W - PAD.left - PAD.right);
  const y = (d: number) => PAD.top + (1 - d / yMax) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.r).toFixed(1)},${y(p.d).toFixed(1)}`).join('');
  const xTicks = ticks(xMax, xMax > 1200 ? 400 : 200);
  const yTicks = ticks(yMax, yMax / 4);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const r = Math.max(0, Math.min(xMax, ((px - PAD.left) / (W - PAD.left - PAD.right)) * xMax));
    const snapped = Math.round(r / STEP) * STEP;
    setHover({ r: snapped, d: damageAtRange(combat, snapped) });
  };

  return (
    <section className="panel range-chart">
      <h3>{t('range.title')}</h3>
      <div className="chart-wrap">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('range.aria', { alpha: fixed(points[0]!.d, 1), range: Math.round(maxRange) })}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="axis" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">{Math.round(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => <text key={`x${v}`} className="axis" x={x(v)} y={H - 8} textAnchor="middle">{v} m</text>)}
          <line className="baseline" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
          <path className="series" d={path} />
          {hover && (
            <g>
              <line className="crosshair" x1={x(hover.r)} x2={x(hover.r)} y1={PAD.top} y2={y(0)} />
              <circle className="marker" cx={x(hover.r)} cy={y(hover.d)} r={4} />
            </g>
          )}
        </svg>
        {hover && (
          <div className="chart-tip" style={{ left: `${(x(hover.r) / W) * 100}%` }}>
            <strong>{fixed(hover.d, 1)}</strong> {t('range.damage')} · {hover.r} m
          </div>
        )}
      </div>
      <p className="hint">{t('range.hint')}</p>
    </section>
  );
}

function niceMax(v: number): number {
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}
function ticks(max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}
