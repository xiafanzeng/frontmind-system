ALTER TABLE `users` ADD CONSTRAINT `users_engineer_role_consistency_ck` CHECK ((
        (`users`.`role` = 'delivery_member' AND `users`.`engineerRoleType` IS NOT NULL)
        OR
        (`users`.`role` <> 'delivery_member' AND `users`.`engineerRoleType` IS NULL)
      ));