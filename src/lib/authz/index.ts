/**
 * The guard. One import for every caller: the Edge middleware, the `(app)`
 * layout, the nav, and the tests.
 *
 * Nothing here touches a cookie store, a request or a database — see
 * `roles.ts` for why (it runs in three runtimes) and `policy.ts` for the
 * decision itself.
 */
export {
  OPERATOR_ROLES,
  ROLES,
  ROLE_COOKIE,
  ROLE_LABEL,
  ROLE_SUMMARY,
  isOperator,
  isRole,
  roleFromCookieValue,
  type Role,
} from "./roles";

export {
  OPERATOR_ONLY,
  ROUTE_SURFACE,
  authorize,
  surfaceOf,
  visibleTo,
  type Decision,
  type RefusalCode,
  type Surface,
} from "./policy";
