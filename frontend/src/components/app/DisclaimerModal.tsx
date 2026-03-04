import React from 'react';

type DisclaimerModalProps = {
  onClose: () => void;
};

export const DisclaimerModal: React.FC<DisclaimerModalProps> = ({ onClose }) => (
  <div className="disclaimer-overlay" role="dialog" aria-modal="true" aria-label="Data disclaimer">
    <div className="disclaimer-modal">
      <h2 className="disclaimer-modal__title">Data disclaimer</h2>
      <div className="disclaimer-modal__body">
        <section>
          <h3>Packet paths</h3>
          <p>
            The relay paths shown on this dashboard are a best estimate. MeshCore packets include
            only the first 2 hex characters of each relay node&apos;s ID, so when resolving a path we
            match those 2 characters against known nodes. If multiple nodes share the same prefix
            the closest candidate is chosen, but the actual path the packet took may have been
            different.
          </p>
        </section>
        <section>
          <h3>Coverage map</h3>
          <p>
            The green coverage layer is a radio horizon estimate computed from SRTM terrain data.
            It assumes each repeater antenna is mounted <strong>5 metres above ground level</strong>.
            Actual coverage will vary with antenna height, local obstacles, foliage, and radio
            conditions. Treat it as a rough guide, not a guarantee of connectivity.
          </p>
        </section>
      </div>
      <button className="disclaimer-modal__close" onClick={onClose}>Got it</button>
    </div>
  </div>
);

