import { Context } from "effect";

export class AuthContext extends Context.Tag("@executor/cloud/AuthContext")<
  AuthContext,
  {
    readonly userId: string;
    readonly teamId: string;
    readonly email: string;
  }
>() {}
