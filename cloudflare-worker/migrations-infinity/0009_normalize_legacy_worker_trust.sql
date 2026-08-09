-- Legacy one-time enrollments originally defaulted to owner_trusted before
-- role-derived trust was introduced. Downgrade those old records to the safe
-- general trust level; a superuser can create a new persistent registration
-- after the current verified role is evaluated.
UPDATE worker_enrollments
SET trust_level = 'institution_trusted'
WHERE trust_level IN ('owner_trusted', 'student_untrusted');

-- A pre-existing persistent row with the old student value must not retain a
-- stricter/lower-than-current policy in the control plane.
UPDATE worker_registrations
SET trust_level = 'institution_trusted'
WHERE trust_level = 'student_untrusted';
