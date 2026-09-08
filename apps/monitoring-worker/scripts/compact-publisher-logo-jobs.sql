-- One-time queue maintenance before enabling Logo processing. Stop the
-- monitoring worker first. This only pauses duplicate unclaimed Logo jobs;
-- it never deletes history, changes a publication, or creates an order.
CREATE TEMPORARY TABLE publisher_logo_job_survivors AS
SELECT aggregate_id,
       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.candidateHash')) AS candidate_hash,
       MIN(id) AS keep_id
FROM publisher_jobs
WHERE type = 'archive_publisher_media_logo' AND status IN ('ready', 'retry_wait')
GROUP BY aggregate_id, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.candidateHash'));

UPDATE publisher_jobs duplicate_job
JOIN publisher_logo_job_survivors survivor
  ON survivor.aggregate_id = duplicate_job.aggregate_id
 AND survivor.candidate_hash = JSON_UNQUOTE(JSON_EXTRACT(duplicate_job.payload, '$.candidateHash'))
SET duplicate_job.status = 'paused',
    duplicate_job.last_error_code = 'LOGO_SUPERSEDED',
    duplicate_job.last_error_message = 'Equivalent pending Logo job retained; no media fetch required'
WHERE duplicate_job.type = 'archive_publisher_media_logo'
  AND duplicate_job.status IN ('ready', 'retry_wait')
  AND duplicate_job.id <> survivor.keep_id;

DROP TEMPORARY TABLE publisher_logo_job_survivors;
