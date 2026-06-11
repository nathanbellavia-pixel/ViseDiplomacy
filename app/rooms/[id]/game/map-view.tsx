"use client";

import { useEffect, useMemo, useRef } from "react";
import { MAP_SVG, MAP_VIEWBOX } from "@/lib/game/map-svg";
import { COAST_UNIT_POS, PROVINCES } from "@/lib/game/map-data";
import { NATION_COLORS, type SummaryOrder, type Territory } from "@/lib/types";
import type { LocalOrder } from "@/app/game-actions";

const RESULT_COLORS: Record<string, string> = {
  success: "#4ade80",
  bounced: "#f87171",
  cut: "#fb923c",
  dislodged: "#ef4444",
  invalid: "#a8a29e",
};

const SVG_ID_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCES).map(([code, info]) => [info.svgId, code])
);

function unitAnchor(t: Territory): { x: number; y: number } {
  if (t.unit_coast) {
    const pos = COAST_UNIT_POS[`${t.code}/${t.unit_coast}`];
    if (pos) return pos;
  }
  return PROVINCES[t.code].unit;
}

function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`);
  }
  return pts.join(" ");
}

export interface MapViewProps {
  territories: Territory[];
  orders: LocalOrder[];
  highlights: Set<string>; // province codes that should glow as valid targets
  selected: string | null; // province of the selected unit
  supportHighlights: Set<string>; // units selectable as support beneficiaries
  disbandMarks: Set<string>;
  buildMarks: { prov: string; unit: "army" | "fleet" }[];
  resultOrders: SummaryOrder[]; // last resolved phase, drawn under everything
  onProvinceClick: (code: string) => void;
  onUnitClick: (code: string) => void;
}

export default function MapView({
  territories,
  orders,
  highlights,
  selected,
  supportHighlights,
  disbandMarks,
  buildMarks,
  resultOrders,
  onProvinceClick,
  onUnitClick,
}: MapViewProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const terrByCode = useMemo(
    () => new Map(territories.map((t) => [t.code, t])),
    [territories]
  );

  const onProvinceClickRef = useRef(onProvinceClick);
  useEffect(() => {
    onProvinceClickRef.current = onProvinceClick;
  }, [onProvinceClick]);

  // The inlined 100KB svg must be injected exactly once: re-rendering the
  // dangerouslySetInnerHTML prop makes React re-set innerHTML, wiping the
  // fills/highlights the effects below paint imperatively. A memoized element
  // is skipped entirely by reconciliation, so the DOM survives re-renders.
  const mapBase = useMemo(
    () => (
      <div
        ref={mapRef}
        onClick={(e) => {
          const target = (e.target as Element).closest('[id^="_"]');
          if (!target) return;
          const code = SVG_ID_TO_CODE[target.id];
          if (code) onProvinceClickRef.current(code);
        }}
        className="[&_svg]:h-auto [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: MAP_SVG }}
      />
    ),
    []
  );

  // Inject a highlight style into the inlined svg once
  useEffect(() => {
    const svg = mapRef.current?.querySelector("svg");
    if (!svg || svg.querySelector("#vd-style")) return;
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.id = "vd-style";
    style.textContent = `
      .vd-highlight { stroke: #f59e0b !important; stroke-width: 3.5 !important; cursor: pointer; }
      .vd-selected { stroke: #fde68a !important; stroke-width: 4 !important; }
      #MapLayer path, #MapLayer polygon, #MapLayer g { cursor: default; }
    `;
    svg.prepend(style);
  }, []);

  // Paint ownership colors onto the province shapes
  useEffect(() => {
    const svg = mapRef.current?.querySelector("svg");
    if (!svg) return;
    for (const [code, info] of Object.entries(PROVINCES)) {
      const el = svg.querySelector(`#${info.svgId}`);
      if (!el) continue;
      const owner = terrByCode.get(code)?.owner_nation;
      const fill = owner && info.type !== "water" ? NATION_COLORS[owner] : "";
      const nodes =
        el.tagName === "g"
          ? Array.from(el.querySelectorAll("path, polygon"))
          : [el];
      for (const node of nodes) {
        (node as SVGElement).style.fill = fill;
        (node as SVGElement).style.fillOpacity = fill ? "0.65" : "";
      }
    }
  }, [terrByCode]);

  // Toggle highlight/selection outlines
  useEffect(() => {
    const svg = mapRef.current?.querySelector("svg");
    if (!svg) return;
    const touched: Element[] = [];
    const mark = (code: string, cls: string) => {
      const el = svg.querySelector(`#${PROVINCES[code]?.svgId}`);
      if (!el) return;
      const nodes =
        el.tagName === "g" ? Array.from(el.querySelectorAll("path, polygon")) : [el];
      for (const node of nodes) {
        node.classList.add(cls);
        node.setAttribute("data-highlight", code);
        touched.push(node);
      }
    };
    highlights.forEach((code) => mark(code, "vd-highlight"));
    if (selected) mark(selected, "vd-selected");
    return () => {
      for (const node of touched) {
        node.classList.remove("vd-highlight", "vd-selected");
        node.removeAttribute("data-highlight");
      }
    };
  }, [highlights, selected]);

  const unitsToDraw = territories.filter((t) => t.unit_type && t.occupant_nation);

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-stone-800 bg-stone-900">
      {mapBase}
      {/* overlay: supply centers, units, orders */}
      <svg
        viewBox={MAP_VIEWBOX}
        className="pointer-events-none absolute inset-0 h-full w-full"
        data-testid="overlay"
      >
        <defs>
          <marker
            id="vd-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
          </marker>
          <marker
            id="vd-arrow-support"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#22d3ee" />
          </marker>
          {Object.entries(RESULT_COLORS).map(([result, color]) => (
            <marker
              key={result}
              id={`vd-arrow-${result}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* last phase results (under everything else) */}
        {resultOrders.map((o) => {
          const fromInfo = PROVINCES[o.prov];
          if (!fromInfo) return null;
          const a = fromInfo.unit;
          const color = RESULT_COLORS[o.result] ?? "#a8a29e";
          if (o.type === "move" || o.type === "retreat") {
            const destProv = o.target?.split("/")[0];
            const b = destProv ? PROVINCES[destProv]?.unit : null;
            if (!b) return null;
            return (
              <g key={`r-${o.prov}`} data-result-arrow={o.prov} data-result={o.result} opacity="0.85">
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={color}
                  strokeWidth="4"
                  markerEnd={`url(#vd-arrow-${o.result in RESULT_COLORS ? o.result : "invalid"})`}
                  strokeDasharray={o.result === "success" ? "14 7" : undefined}
                >
                  {o.result === "success" && (
                    <animate
                      attributeName="stroke-dashoffset"
                      from="42"
                      to="0"
                      dur="1.2s"
                      repeatCount="indefinite"
                    />
                  )}
                </line>
                {o.result === "bounced" && (
                  <text
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 + 6}
                    textAnchor="middle"
                    fontSize="22"
                    fontWeight="bold"
                    fill={color}
                  >
                    ✕
                  </text>
                )}
              </g>
            );
          }
          if (o.type === "support" && o.aux) {
            const auxPos = PROVINCES[o.aux]?.unit;
            const destPos =
              o.target && o.target !== o.aux ? PROVINCES[o.target]?.unit : auxPos;
            if (!auxPos || !destPos) return null;
            return (
              <line
                key={`r-${o.prov}`}
                data-result-arrow={o.prov}
                data-result={o.result}
                x1={a.x}
                y1={a.y}
                x2={destPos.x}
                y2={destPos.y}
                stroke={color}
                strokeWidth="3"
                strokeDasharray="6 5"
                opacity="0.7"
              />
            );
          }
          if (o.result === "dislodged") {
            return (
              <text
                key={`r-${o.prov}`}
                data-result-arrow={o.prov}
                data-result="dislodged"
                x={a.x + 14}
                y={a.y - 12}
                fontSize="20"
                fontWeight="bold"
                fill={RESULT_COLORS.dislodged}
              >
                ⚠
              </text>
            );
          }
          return null;
        })}

        {/* supply-center stars */}
        {territories
          .filter((t) => t.is_supply_center && PROVINCES[t.code]?.scPos)
          .map((t) => {
            const { x, y } = PROVINCES[t.code].scPos!;
            return (
              <polygon
                key={`sc-${t.code}`}
                points={starPoints(x, y, 9)}
                fill={t.owner_nation ? NATION_COLORS[t.owner_nation] : "#d6d3d1"}
                stroke="#1c1917"
                strokeWidth="1.5"
                data-sc={t.code}
              />
            );
          })}

        {/* order drawings (under units) */}
        {orders.map((o) => {
          const from = terrByCode.get(o.prov);
          if (!from) return null;
          const a = unitAnchor(from);
          if (o.type === "hold") {
            return (
              <circle
                key={`o-${o.prov}`}
                cx={a.x}
                cy={a.y}
                r={20}
                fill="none"
                stroke="#fbbf24"
                strokeWidth="3"
                data-order-indicator={o.prov}
                data-order-type="hold"
              />
            );
          }
          if (o.type === "move" && o.target) {
            const b = PROVINCES[o.target].unit;
            return (
              <line
                key={`o-${o.prov}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#fbbf24"
                strokeWidth="5"
                markerEnd="url(#vd-arrow)"
                data-order-arrow={o.prov}
                data-order-type="move"
              />
            );
          }
          if ((o.type === "support-hold" || o.type === "support-move") && o.aux) {
            const auxTerr = terrByCode.get(o.aux);
            const auxPos = auxTerr ? unitAnchor(auxTerr) : PROVINCES[o.aux].unit;
            const destPos =
              o.type === "support-move" && o.target
                ? PROVINCES[o.target].unit
                : auxPos;
            return (
              <g key={`o-${o.prov}`} data-order-indicator={o.prov} data-order-type={o.type}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={destPos.x}
                  y2={destPos.y}
                  stroke="#22d3ee"
                  strokeWidth="4"
                  strokeDasharray="10 6"
                  markerEnd="url(#vd-arrow-support)"
                />
                {o.type === "support-hold" && (
                  <circle
                    cx={auxPos.x}
                    cy={auxPos.y}
                    r={24}
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth="3"
                    strokeDasharray="8 5"
                  />
                )}
              </g>
            );
          }
          return null;
        })}

        {/* build marks */}
        {buildMarks.map((b) => {
          const p = PROVINCES[b.prov].unit;
          return (
            <g key={`b-${b.prov}`} data-build-mark={b.prov}>
              <circle cx={p.x} cy={p.y} r={16} fill="#16a34a" opacity="0.85" />
              <text
                x={p.x}
                y={p.y + 6}
                textAnchor="middle"
                fontSize="22"
                fontWeight="bold"
                fill="white"
              >
                +
              </text>
            </g>
          );
        })}

        {/* units */}
        {unitsToDraw.map((t) => {
          const { x, y } = unitAnchor(t);
          const color = NATION_COLORS[t.occupant_nation!];
          const isSelected = selected === t.code;
          const isSupportable = supportHighlights.has(t.code);
          const isDisband = disbandMarks.has(t.code);
          return (
            <g
              key={`u-${t.code}`}
              className="pointer-events-auto cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onUnitClick(t.code);
              }}
              data-unit={t.code}
              data-nation={t.occupant_nation}
              data-unit-type={t.unit_type}
            >
              {(isSelected || isSupportable) && (
                <circle
                  cx={x}
                  cy={y}
                  r={19}
                  fill="none"
                  stroke={isSelected ? "#fde68a" : "#22d3ee"}
                  strokeWidth="3"
                  strokeDasharray={isSupportable && !isSelected ? "6 4" : undefined}
                />
              )}
              {t.unit_type === "army" ? (
                <circle cx={x} cy={y} r={12} fill={color} stroke="#0c0a09" strokeWidth="2.5" />
              ) : (
                <path
                  d={`M ${x - 15},${y + 2} L ${x + 15},${y + 2} L ${x + 9},${y + 11} L ${x - 9},${y + 11} Z M ${x - 1.5},${y + 2} L ${x - 1.5},${y - 12} L ${x + 10},${y - 3} L ${x - 1.5},${y - 3}`}
                  fill={color}
                  stroke="#0c0a09"
                  strokeWidth="2"
                />
              )}
              <text
                x={x}
                y={y - 16}
                textAnchor="middle"
                fontSize="13"
                fontWeight="bold"
                fill="#fafaf9"
                stroke="#0c0a09"
                strokeWidth="0.6"
                style={{ pointerEvents: "none" }}
              >
                {t.unit_type === "army" ? "A" : "F"}
              </text>
              {isDisband && (
                <text
                  x={x}
                  y={y + 7}
                  textAnchor="middle"
                  fontSize="26"
                  fontWeight="bold"
                  fill="#ef4444"
                  data-disband-mark={t.code}
                  style={{ pointerEvents: "none" }}
                >
                  ✕
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
