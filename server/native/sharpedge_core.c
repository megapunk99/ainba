/**
 * SHARPEDGE Native Core — C
 * 
 * High-performance computation for NBA betting analytics.
 * Exposed to Node.js via N-API.
 * 
 * Functions:
 * - Odds: American to decimal, implied probability, vig removal
 * - Kelly: Full Kelly, fractional Kelly, optimal bet sizing
 * - Stats: Weighted average, standard deviation, hit rate, consistency
 * - Probability: Win probability from ratings, projection from gamelogs
 * - Line Movement: Sharp money detection, reverse line movement
 */

#include <node_api.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef NAPI_VERSION
#define NAPI_VERSION 6
#endif

// ═══════════════════════════════════════════════════════════════
// ODDS CONVERSION
// ═══════════════════════════════════════════════════════════════

static napi_value american_to_decimal(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double american;
    napi_get_value_double(env, args[0], &american);

    double decimal;
    if (american > 0) {
        decimal = 1.0 + (american / 100.0);
    } else {
        decimal = 1.0 + (100.0 / fabs(american));
    }

    napi_value result;
    napi_create_double(env, decimal, &result);
    return result;
}

static napi_value american_to_implied_prob(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double american;
    napi_get_value_double(env, args[0], &american);

    double prob;
    if (american > 0) {
        prob = 100.0 / (american + 100.0);
    } else {
        prob = fabs(american) / (fabs(american) + 100.0);
    }

    napi_value result;
    napi_create_double(env, prob, &result);
    return result;
}

static napi_value remove_vig(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double homeAmerican, awayAmerican;
    napi_get_value_double(env, args[0], &homeAmerican);
    napi_get_value_double(env, args[1], &awayAmerican);

    double homeImp, awayImp;
    if (homeAmerican > 0) {
        homeImp = 100.0 / (homeAmerican + 100.0);
    } else {
        homeImp = fabs(homeAmerican) / (fabs(homeAmerican) + 100.0);
    }
    if (awayAmerican > 0) {
        awayImp = 100.0 / (awayAmerican + 100.0);
    } else {
        awayImp = fabs(awayAmerican) / (fabs(awayAmerican) + 100.0);
    }

    double totalImp = homeImp + awayImp;
    double vig = totalImp - 1.0;
    double homeProb = homeImp / totalImp;
    double awayProb = awayImp / totalImp;

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_double(env, homeProb, &val);
    napi_set_named_property(env, obj, "homeProb", val);

    napi_create_double(env, awayProb, &val);
    napi_set_named_property(env, obj, "awayProb", val);

    napi_create_double(env, vig, &val);
    napi_set_named_property(env, obj, "vig", val);

    return obj;
}

// ═══════════════════════════════════════════════════════════════
// KELLY CRITERION
// ═══════════════════════════════════════════════════════════════

static napi_value kelly_criterion(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double trueProb, decimalOdds, fraction;
    napi_get_value_double(env, args[0], &trueProb);
    napi_get_value_double(env, args[1], &decimalOdds);
    fraction = 0.25;
    if (argc >= 3) {
        napi_get_value_double(env, args[2], &fraction);
    }

    double b = decimalOdds - 1.0;
    double q = 1.0 - trueProb;

    double fullKelly = (b * trueProb - q) / b;
    if (fullKelly < 0) fullKelly = 0;
    if (fullKelly > 0.25) fullKelly = 0.25;

    double fractionalKelly = fullKelly * fraction;
    double recommendedBet = fractionalKelly * 100.0;
    double ev = (trueProb * (decimalOdds - 1.0)) - (1.0 - trueProb);

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_double(env, fullKelly, &val);
    napi_set_named_property(env, obj, "fullKelly", val);

    napi_create_double(env, fractionalKelly, &val);
    napi_set_named_property(env, obj, "fractionalKelly", val);

    napi_create_double(env, recommendedBet, &val);
    napi_set_named_property(env, obj, "recommendedPct", val);

    napi_create_double(env, ev, &val);
    napi_set_named_property(env, obj, "expectedValue", val);

    napi_get_boolean(env, ev > 0, &val);
    napi_set_named_property(env, obj, "isPositiveEV", val);

    return obj;
}

// ═══════════════════════════════════════════════════════════════
// STATISTICAL FUNCTIONS
// ═══════════════════════════════════════════════════════════════

static napi_value weighted_average(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint32_t count;
    napi_get_array_length(env, args[0], &count);

    double sumVal = 0, sumWt = 0;
    for (uint32_t i = 0; i < count; i++) {
        napi_value v, w;
        napi_get_element(env, args[0], i, &v);
        napi_get_element(env, args[1], i, &w);
        double val, wt;
        napi_get_value_double(env, v, &val);
        napi_get_value_double(env, w, &wt);
        sumVal += val * wt;
        sumWt += wt;
    }

    double result = sumWt > 0 ? sumVal / sumWt : 0;
    napi_value res;
    napi_create_double(env, result, &res);
    return res;
}

static napi_value statistics(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint32_t count;
    napi_get_array_length(env, args[0], &count);
    
    if (count == 0) {
        napi_value obj;
        napi_create_object(env, &obj);
        napi_value val;
        napi_create_uint32(env, 0, &val);
        napi_set_named_property(env, obj, "count", val);
        return obj;
    }

    double *vals = (double *)malloc(count * sizeof(double));
    double sum = 0;
    for (uint32_t i = 0; i < count; i++) {
        napi_value v;
        napi_get_element(env, args[0], i, &v);
        napi_get_value_double(env, v, &vals[i]);
        sum += vals[i];
    }

    double mean = sum / count;

    double varSum = 0;
    for (uint32_t i = 0; i < count; i++) {
        varSum += (vals[i] - mean) * (vals[i] - mean);
    }
    double variance = varSum / count;
    double stddev = sqrt(variance);

    /* Insertion sort for median */
    for (uint32_t i = 1; i < count; i++) {
        double key = vals[i];
        int j = (int)i - 1;
        while (j >= 0 && vals[j] > key) {
            vals[j + 1] = vals[j];
            j--;
        }
        vals[j + 1] = key;
    }
    double median;
    if (count % 2 == 0) {
        median = (vals[count/2 - 1] + vals[count/2]) / 2.0;
    } else {
        median = vals[count/2];
    }

    double min_val = vals[0];
    double max_val = vals[count - 1];
    double cv = mean > 0 ? (stddev / mean) * 100.0 : 0;

    free(vals);

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_double(env, mean, &val);
    napi_set_named_property(env, obj, "mean", val);
    napi_create_double(env, stddev, &val);
    napi_set_named_property(env, obj, "stddev", val);
    napi_create_double(env, variance, &val);
    napi_set_named_property(env, obj, "variance", val);
    napi_create_double(env, median, &val);
    napi_set_named_property(env, obj, "median", val);
    napi_create_double(env, min_val, &val);
    napi_set_named_property(env, obj, "min", val);
    napi_create_double(env, max_val, &val);
    napi_set_named_property(env, obj, "max", val);
    napi_create_double(env, cv, &val);
    napi_set_named_property(env, obj, "cv", val);
    napi_create_uint32(env, count, &val);
    napi_set_named_property(env, obj, "count", val);

    return obj;
}

static napi_value hit_rate(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint32_t count;
    napi_get_array_length(env, args[0], &count);
    double line;
    napi_get_value_double(env, args[1], &line);

    uint32_t hits = 0;
    for (uint32_t i = 0; i < count; i++) {
        napi_value v;
        napi_get_element(env, args[0], i, &v);
        double val;
        napi_get_value_double(env, v, &val);
        if (val > line) hits++;
    }

    double rate = count > 0 ? (double)hits / count : 0;

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_uint32(env, hits, &val);
    napi_set_named_property(env, obj, "hits", val);
    napi_create_uint32(env, count, &val);
    napi_set_named_property(env, obj, "total", val);
    napi_create_double(env, rate, &val);
    napi_set_named_property(env, obj, "rate", val);

    return obj;
}

// ═══════════════════════════════════════════════════════════════
// WIN PROBABILITY
// ═══════════════════════════════════════════════════════════════

static napi_value win_probability(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double homeRating, awayRating, hca;
    napi_get_value_double(env, args[0], &homeRating);
    napi_get_value_double(env, args[1], &awayRating);
    hca = 3.5;
    if (argc >= 3) {
        napi_get_value_double(env, args[2], &hca);
    }

    double adjHome = homeRating + hca;
    double diff = adjHome - awayRating;
    double homeProb = 1.0 / (1.0 + exp(-diff * 0.1));
    double awayProb = 1.0 - homeProb;
    double margin = diff * 0.4;

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_double(env, homeProb, &val);
    napi_set_named_property(env, obj, "homeProb", val);
    napi_create_double(env, awayProb, &val);
    napi_set_named_property(env, obj, "awayProb", val);
    napi_create_double(env, margin, &val);
    napi_set_named_property(env, obj, "predictedMargin", val);

    return obj;
}

static napi_value player_projection(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value args[6];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double seasonAvg, last5, last10, w5, w10, wSeason;
    napi_get_value_double(env, args[0], &seasonAvg);
    napi_get_value_double(env, args[1], &last5);
    napi_get_value_double(env, args[2], &last10);
    napi_get_value_double(env, args[3], &w5);
    napi_get_value_double(env, args[4], &w10);
    napi_get_value_double(env, args[5], &wSeason);

    double totalW = w5 + w10 + wSeason;
    double projection = (last5 * w5 + last10 * w10 + seasonAvg * wSeason) / totalW;

    napi_value result;
    napi_create_double(env, projection, &result);
    return result;
}

static napi_value prop_score(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    double fairLine, sportsbookLine, cv;
    int32_t gamesPlayed;
    napi_get_value_double(env, args[0], &fairLine);
    napi_get_value_double(env, args[1], &sportsbookLine);
    napi_get_value_double(env, args[2], &cv);
    napi_get_value_int32(env, args[3], &gamesPlayed);

    double edge = fairLine - sportsbookLine;
    double absEdge = fabs(edge);

    double edgeScore = fmin(50.0, absEdge * 8.0);
    double consScore = fmax(0.0, 25.0 - cv * 0.5);
    double sampleScore = fmin(25.0, (double)gamesPlayed * 1.5);
    double score = edgeScore + consScore + sampleScore;
    if (score > 100.0) score = 100.0;
    if (score < 0.0) score = 0.0;

    const char *confidence = "LOW";
    if (score >= 70.0) confidence = "HIGH";
    else if (score >= 45.0) confidence = "MEDIUM";

    const char *valueRating = "AVOID";
    if (score >= 80.0 && absEdge >= 3.0) valueRating = "STRONG";
    else if (score >= 60.0 && absEdge >= 2.0) valueRating = "GOOD";
    else if (score >= 40.0 && absEdge >= 1.5) valueRating = "FAIR";
    else if (score >= 25.0) valueRating = "MARGINAL";

    const char *rec = "PASS";
    if (edge > 0.5) rec = "OVER";
    else if (edge < -0.5) rec = "UNDER";

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_create_double(env, edge, &val);
    napi_set_named_property(env, obj, "edge", val);
    napi_create_double(env, absEdge, &val);
    napi_set_named_property(env, obj, "absEdge", val);
    napi_create_double(env, score, &val);
    napi_set_named_property(env, obj, "score", val);
    napi_create_string_utf8(env, confidence, strlen(confidence), &val);
    napi_set_named_property(env, obj, "confidence", val);
    napi_create_string_utf8(env, valueRating, strlen(valueRating), &val);
    napi_set_named_property(env, obj, "valueRating", val);
    napi_create_string_utf8(env, rec, strlen(rec), &val);
    napi_set_named_property(env, obj, "recommendation", val);

    return obj;
}

// ═══════════════════════════════════════════════════════════════
// SHARP MONEY DETECTION
// ═══════════════════════════════════════════════════════════════

static napi_value detect_sharp_money(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint32_t bookCount;
    napi_get_array_length(env, args[0], &bookCount);

    if (bookCount < 2) {
        napi_value obj;
        napi_create_object(env, &obj);
        napi_value val;
        napi_get_boolean(env, 0, &val);
        napi_set_named_property(env, obj, "isSharp", val);
        napi_create_string_utf8(env, "INSUFFICIENT_DATA", 17, &val);
        napi_set_named_property(env, obj, "signal", val);
        napi_create_double(env, 0.0, &val);
        napi_set_named_property(env, obj, "sharpScore", val);
        return obj;
    }

    double *homeMLs = (double *)malloc(bookCount * sizeof(double));
    double *spreads = (double *)malloc(bookCount * sizeof(double));
    double *totals = (double *)malloc(bookCount * sizeof(double));
    uint32_t mlCount = 0, spreadCount = 0, totalCount = 0;

    for (uint32_t i = 0; i < bookCount; i++) {
        napi_value bookObj, val;
        napi_get_element(env, args[0], i, &bookObj);
        double dval;

        if (napi_get_named_property(env, bookObj, "homeML", &val) == napi_ok &&
            napi_get_value_double(env, val, &dval) == napi_ok && dval != 0) {
            homeMLs[mlCount++] = dval;
        }
        if (napi_get_named_property(env, bookObj, "homeSpread", &val) == napi_ok &&
            napi_get_value_double(env, val, &dval) == napi_ok && dval != 0) {
            spreads[spreadCount++] = dval;
        }
        if (napi_get_named_property(env, bookObj, "total", &val) == napi_ok &&
            napi_get_value_double(env, val, &dval) == napi_ok && dval != 0) {
            totals[totalCount++] = dval;
        }
    }

    double mlGap = 0, spreadGap = 0, totalGap = 0;

    if (mlCount >= 2) {
        double minML = homeMLs[0], maxML = homeMLs[0];
        for (uint32_t i = 1; i < mlCount; i++) {
            if (homeMLs[i] < minML) minML = homeMLs[i];
            if (homeMLs[i] > maxML) maxML = homeMLs[i];
        }
        mlGap = maxML - minML;
    }
    if (spreadCount >= 2) {
        double minS = spreads[0], maxS = spreads[0];
        for (uint32_t i = 1; i < spreadCount; i++) {
            if (spreads[i] < minS) minS = spreads[i];
            if (spreads[i] > maxS) maxS = spreads[i];
        }
        spreadGap = fabs(maxS - minS);
    }
    if (totalCount >= 2) {
        double minT = totals[0], maxT = totals[0];
        for (uint32_t i = 1; i < totalCount; i++) {
            if (totals[i] < minT) minT = totals[i];
            if (totals[i] > maxT) maxT = totals[i];
        }
        totalGap = fabs(maxT - minT);
    }

    free(homeMLs); free(spreads); free(totals);

    double sharpScore = 0;
    if (mlGap >= 15) sharpScore += 40;
    else if (mlGap >= 10) sharpScore += 25;
    else if (mlGap >= 5) sharpScore += 10;
    if (spreadGap >= 2.0) sharpScore += 40;
    else if (spreadGap >= 1.0) sharpScore += 20;
    else if (spreadGap >= 0.5) sharpScore += 10;
    if (totalGap >= 3.0) sharpScore += 30;
    else if (totalGap >= 2.0) sharpScore += 15;
    else if (totalGap >= 1.0) sharpScore += 8;

    int isSharp = sharpScore >= 30;
    const char *signal = "NONE";
    if (sharpScore >= 50) signal = "STRONG";
    else if (sharpScore >= 30) signal = "MODERATE";
    else if (sharpScore >= 15) signal = "WEAK";

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value val;

    napi_get_boolean(env, isSharp, &val);
    napi_set_named_property(env, obj, "isSharp", val);
    napi_create_string_utf8(env, signal, strlen(signal), &val);
    napi_set_named_property(env, obj, "signal", val);
    napi_create_double(env, sharpScore, &val);
    napi_set_named_property(env, obj, "sharpScore", val);
    napi_create_double(env, mlGap, &val);
    napi_set_named_property(env, obj, "mlGap", val);
    napi_create_double(env, spreadGap, &val);
    napi_set_named_property(env, obj, "spreadGap", val);
    napi_create_double(env, totalGap, &val);
    napi_set_named_property(env, obj, "totalGap", val);

    return obj;
}

// ═══════════════════════════════════════════════════════════════
// MODULE INIT
// ═══════════════════════════════════════════════════════════════

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;

    napi_create_function(env, "americanToDecimal", NAPI_AUTO_LENGTH, american_to_decimal, NULL, &fn);
    napi_set_named_property(env, exports, "americanToDecimal", fn);

    napi_create_function(env, "americanToImpliedProb", NAPI_AUTO_LENGTH, american_to_implied_prob, NULL, &fn);
    napi_set_named_property(env, exports, "americanToImpliedProb", fn);

    napi_create_function(env, "removeVig", NAPI_AUTO_LENGTH, remove_vig, NULL, &fn);
    napi_set_named_property(env, exports, "removeVig", fn);

    napi_create_function(env, "kellyCriterion", NAPI_AUTO_LENGTH, kelly_criterion, NULL, &fn);
    napi_set_named_property(env, exports, "kellyCriterion", fn);

    napi_create_function(env, "weightedAverage", NAPI_AUTO_LENGTH, weighted_average, NULL, &fn);
    napi_set_named_property(env, exports, "weightedAverage", fn);

    napi_create_function(env, "statistics", NAPI_AUTO_LENGTH, statistics, NULL, &fn);
    napi_set_named_property(env, exports, "statistics", fn);

    napi_create_function(env, "hitRate", NAPI_AUTO_LENGTH, hit_rate, NULL, &fn);
    napi_set_named_property(env, exports, "hitRate", fn);

    napi_create_function(env, "winProbability", NAPI_AUTO_LENGTH, win_probability, NULL, &fn);
    napi_set_named_property(env, exports, "winProbability", fn);

    napi_create_function(env, "playerProjection", NAPI_AUTO_LENGTH, player_projection, NULL, &fn);
    napi_set_named_property(env, exports, "playerProjection", fn);

    napi_create_function(env, "propScore", NAPI_AUTO_LENGTH, prop_score, NULL, &fn);
    napi_set_named_property(env, exports, "propScore", fn);

    napi_create_function(env, "detectSharpMoney", NAPI_AUTO_LENGTH, detect_sharp_money, NULL, &fn);
    napi_set_named_property(env, exports, "detectSharpMoney", fn);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
