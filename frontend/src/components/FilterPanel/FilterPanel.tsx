import React from 'react';

export interface Filters {
  livePackets:   boolean;
  coverage:      boolean;
  clientNodes:   boolean;
  packetPaths:   boolean;
}

interface FilterPanelProps {
  filters:  Filters;
  onChange: (f: Filters) => void;
}

export const FILTER_ROWS: Array<{ key: keyof Filters; label: string; color: string; hollow?: boolean }> = [
  { key: 'livePackets',  label: 'Live Feed',        color: '#00c4ff' },
  { key: 'packetPaths',  label: 'Packet Paths',     color: '#00c4ff', hollow: true },
  { key: 'coverage',     label: 'Coverage',         color: '#00e676' },
  { key: 'clientNodes',  label: 'Companion / Room', color: '#ff9800' },
];

export const FilterPanel: React.FC<FilterPanelProps> = ({ filters, onChange }) => {
  const toggle = (key: keyof Filters) => {
    onChange({ ...filters, [key]: !filters[key] });
  };

  return (
    <div className="filter-panel">
      <div className="filter-panel__title">Layers</div>
      {FILTER_ROWS.map(({ key, label, color, hollow }) => (
        <div
          key={key}
          className="filter-row"
          onClick={() => toggle(key)}
          role="button"
          aria-pressed={filters[key]}
        >
          <span className="filter-row__label">
            {hollow ? (
              <span
                className="filter-dot filter-dot--hollow"
                style={{
                  borderColor: color,
                  opacity:     filters[key] ? 1 : 0.4,
                }}
              />
            ) : (
              <span className="filter-dot" style={{ background: color, opacity: filters[key] ? 1 : 0.3 }} />
            )}
            {label}
          </span>
          <span className={`filter-toggle ${filters[key] ? 'filter-toggle--on' : ''}`}
                style={filters[key] ? { background: `${color}22`, borderColor: color } : {}}
          />
        </div>
      ))}
    </div>
  );
};
