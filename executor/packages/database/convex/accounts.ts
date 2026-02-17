import { authedMutation } from "../../core/src/function-builders";
import { deleteCurrentAccountHandler } from "../src/accounts/delete-current-account";

export const deleteCurrentAccount = authedMutation({
  method: "POST",
  args: {},
  handler: deleteCurrentAccountHandler,
});
