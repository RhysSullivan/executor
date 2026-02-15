import { $ } from "bun"
import { readFileSync } from "node:fs"
const coreRefactorGoal = readFileSync("executor/convex-core-refactor-code-plan", "utf-8")

const STOP_TOKEN = '<I HAVE COMPLETED THE TASK>'

const makePrompt = (goal: string) => `Continue working until you believe the task is complete. As a reminder, the goal is: ${goal}. The above goal was copy pasted in, resume from where you left off. Output ${STOP_TOKEN} when you have completed the task.`


async function run(goal: string) {
    const prompt = makePrompt(goal)
    let ralph = ''
    while (!ralph.includes(STOP_TOKEN)) {
        ralph = await $`opencode run --attach http://100.81.219.45:39821 --continue ${prompt}`.text()
    }
    return ralph
}

await run(coreRefactorGoal)

