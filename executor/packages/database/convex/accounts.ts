import { authedMutation } from "../../core/src/function-builders";
import { deleteCurrentAccountHandler } from "../src/accounts/delete-current-account";

export const deleteCurrentAccount = authedMutation({
  args: {},
  handler: deleteCurrentAccountHandler,
});
