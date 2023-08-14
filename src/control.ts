//

const HEATER_Watts = 2400;
// If available power is this = always on
const FREE_HEAT_Above = 3600;


export enum PowerState {
    Undefined,
    Off,
    TurningOn,
    On,
    TurningOff
}

let currentState: PowerState = PowerState.Undefined;
let retainstateUntil:bigint= BigInt(0);
// 15 secods
const StabilizationTime= BigInt(1000000000 * 15);


function State2Bool(state:PowerState):boolean
{
    switch (state)
    {
        case PowerState.Off:
        case PowerState.TurningOff:
            return false;
        case PowerState.TurningOn:
        case PowerState.On:
            return true;
    }

    return false;
}

function calculateNow(power:number, temperature:number, heating: boolean):boolean
{
    const reqPower = Math.min(FREE_HEAT_Above, 125.0 * temperature - 3950) - (heating? HEATER_Watts :0);
    return (power > reqPower);
}

function setNewState(newState:PowerState)
{
    currentState = newState;
    switch (newState)
    {
        case PowerState.TurningOff:
        case PowerState.TurningOn:
            retainstateUntil = process.hrtime.bigint() + StabilizationTime;
            break;
        default:
            retainstateUntil = process.hrtime.bigint();

    }

}

export function GetState(power:number, temperature:number, heaterOn:boolean):boolean
{

    if (process.hrtime.bigint() < retainstateUntil)
        return State2Bool(currentState);

    if (heaterOn)
        power += HEATER_Watts;

    const newTarget = calculateNow(power, temperature, currentState == PowerState.On);

    switch(currentState)
    {
        case PowerState.Undefined:
            setNewState(newTarget ? PowerState.TurningOn : PowerState.TurningOff);
            break;
        case PowerState.Off:
            if (newTarget)
                setNewState(PowerState.TurningOn);
            break;
        case PowerState.On:
            if (!newTarget)
                setNewState(PowerState.TurningOff);
            break;
        case PowerState.TurningOn:
                setNewState(PowerState.On);
            break;
        case PowerState.TurningOff:
                setNewState(PowerState.Off);
            break;
    }

    return State2Bool(currentState);

}