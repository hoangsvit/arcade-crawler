# Durable monthly Arcade history

`data/arcade_monthly_games.json` remains the latest active snapshot.

`data/arcade_monthly_games_history/YYYY-MM.json` is append-only by month. The crawler now fills it from two official signals:

1. active monthly Arcade cards, enriched from each game detail page; and
2. the official **Game over** history section, whose HTML month comments are used to reconstruct months that predate the active monthly crawler.

Historical entries carry an explicit `month`, `source`, `status`, and `reconstructed` marker. The archive merger prefers a matching game id/title and keeps richer non-null data when the active crawler later observes the same game.

This means a badge such as a September game can still be classified after October replaces the active snapshot, while Jan-Aug 2026 can be backfilled from the official Arcade history instead of being guessed from badge names.
