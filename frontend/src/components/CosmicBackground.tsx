/** The fixed deep-space backdrop for the whole studio (nebula + drifting stars +
 *  breathing aurora). Pure CSS layers (see index.css); honors reduced-motion. */
export function CosmicBackground() {
  return (
    <div className="akis-cosmos" aria-hidden="true">
      <div className="akis-aurora" />
      <div className="akis-stars" />
    </div>
  )
}
