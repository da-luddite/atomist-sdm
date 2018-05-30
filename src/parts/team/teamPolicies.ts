/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { logger } from "@atomist/automation-client";
import { FingerprintListener, SoftwareDeliveryMachine } from "@atomist/sdm";
import { slackReviewListener } from "@atomist/sdm/code/review/slackReviewListener";
import { GraphGoalsToSlack } from "@atomist/sdm/goal/graph/graphGoalsToSlack";
import { slocCommand } from "@atomist/sdm/handlers/commands/sloc";
import { OnDryRunBuildComplete } from "@atomist/sdm/handlers/events/dry-run/OnDryRunBuildComplete";
import { PostToDeploymentsChannel } from "../../blueprint/deploy/postToDeploymentsChannel";
import { capitalizer } from "../../blueprint/issue/capitalizer";
import { requestDescription } from "../../blueprint/issue/requestDescription";
import { thankYouYouRock } from "../../blueprint/issue/thankYouYouRock";
import { PublishNewRepo } from "../../blueprint/repo/publishNewRepo";
import { addApacheLicenseHeaderEditor } from "../../commands/editors/license/addHeader";
import { codeMetrics } from "../../pack/codemetrics/codeMetrics";
import { SonarQubeSupport } from "../../pack/sonarqube/sonarQubeSupport";

/**
 * Set up team policies independent of specific stacks
 * @param {SoftwareDeliveryMachine} sdm
 */
export function addTeamPolicies(sdm: SoftwareDeliveryMachine) {
    sdm
        .addNewIssueListeners(requestDescription, capitalizer)
        .addClosedIssueListeners(thankYouYouRock)
        .addGoalsSetListeners(GraphGoalsToSlack)
        // .addArtifactListeners(OWASPDependencyCheck)
        .addReviewListeners(
            slackReviewListener(),
        )
        .addEditors(
            () => addApacheLicenseHeaderEditor,
        )
        .addNewRepoWithCodeActions(
            PublishNewRepo)
        // .addCodeReactions(NoPushToDefaultBranchWithoutPullRequest)
        .addDeploymentListeners(PostToDeploymentsChannel)
        .addSupportingCommands(() => slocCommand)
        .addSupportingEvents(() => new OnDryRunBuildComplete(sdm.options.repoRefResolver))
        .addUserJoiningChannelListeners(je =>
            je.addressChannels(`Welcome, ${je.joinEvent.user.screenName}`));
    // .addFingerprintDifferenceListeners(diff1)

    if (sdm.configuration.sdm.sonar && sdm.configuration.sdm.sonar.enabled) {
        logger.info("Enabling SonarQube integration");
        sdm.addExtensionPacks(SonarQubeSupport);
    } else {
        logger.info("SonarQube integration not enabled");
    }

    const pub: FingerprintListener = async fp => {
        // ("METRICS ARE\n" + JSON.stringify(fp.fingerprint));
    };
    sdm.addExtensionPacks(codeMetrics(pub));

    // sdm.addPushReactions(shutDownDeliveryIf(EverySecondOneGoesThrough));
}
