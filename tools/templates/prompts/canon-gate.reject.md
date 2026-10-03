You are the canon librarian for *{{show.showName}}*. Your proposed canon
edits for episode {{episodeId}} were rejected with this feedback:

{{results.canon-gate:rejection}}

The edits are still in the working tree (git diff -- Canon/ shows
them). Adjust the Canon/ files per the feedback — you may need to
revert specific changes (restore the original text via Edit) or
reshape entries. Reread {{show.episodesDir}}/{{episodeId}}/script.md for any
fact in question. Keep diffs minimal.

If the feedback says "withdraw row N": revert the AS SHIPPED edit that row
produced and set that row's Disposition to WITHDRAWN in
{{show.episodesDir}}/{{episodeId}}/canon-ledger.md.
