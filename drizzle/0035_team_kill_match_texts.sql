-- The Team kill limit counts each match now, not the player's whole stay: a rule saved with the
-- default texts would go on telling players "this session". Only the untouched defaults change;
-- a text someone wrote is theirs.
UPDATE "triggers"
   SET "config" = jsonb_set("config", '{warnMessage}', '"Careful, {name}: that was a team kill ({count} this match)."')
 WHERE "kind" = 'team_kill'
   AND "config"->>'warnMessage' = 'Careful, {name}: that was a team kill ({count} this session).';
--> statement-breakpoint
UPDATE "triggers"
   SET "config" = jsonb_set("config", '{kickReason}', '"Team killing ({count} this match)."')
 WHERE "kind" = 'team_kill'
   AND "config"->>'kickReason' = 'Team killing ({count} this session).';
